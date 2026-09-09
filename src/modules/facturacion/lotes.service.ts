import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  LoteFacturacion,
  LoteFacturacionDocument,
  NovedadLote,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  ValorRecurrente,
  ValorRecurrenteDocument,
} from '../../database/schemas/conceptos/valor-recurrente.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../../database/schemas/contabilidad/cuenta-contable.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { PeriodoService } from '../../common/contabilidad/periodo.service';
import { codigoDeCuentaContable } from '../../common/utils/mapper.utils';
import {
  NumeracionService,
  type NumeroAsignado,
} from '../../common/numeracion/numeracion.service';
import type {
  LoteFacturacion as LoteContract,
  LoteFacturacionDetalle,
} from '../../contracts';
import { toLote, toLoteDetalle } from './lotes.mapper';
import type { CrearLoteDto } from './dto/crear-lote.dto';
import type { ActualizarLoteDto } from './dto/actualizar-lote.dto';
import type { NovedadFilaDto } from './dto/cargar-novedades.dto';
import type {
  AgregarNovedadLineaDto,
  EditarNovedadLineaDto,
} from './dto/novedad-linea.dto';
import type { ResultadoCargaNovedades } from '../../contracts';
import type { ErrorConsolidacion } from '../../contracts';
import {
  construirMovimientos,
  cuentasOrdenDe,
  enriquecerMovimientosConAuxiliares,
  CUENTA_SIN_ASIGNAR,
  type MarcasCuentaContable,
} from './asiento.builder';

/**
 * CANONICAL CONSTRUCTOR — pinned here and never changed by a later task in
 * this plan. `terceros` and `copropiedades` are unused until Tasks 9 and 10
 * respectively, but declaring the full shape now means every later task only
 * adds methods, never edits this parameter list — the single biggest source
 * of silent test/implementation drift in a plan built task-by-task. Every
 * test in Tasks 6, 7, 9, and 10 constructs this class with all twelve
 * arguments, in this exact order, using `{} as never` for whichever ones
 * that particular test does not exercise.
 *
 * `cuentasContables` was APPENDED as a thirteenth argument, and made
 * OPTIONAL, when tercero/centro de costos/flujo de caja auxiliares shipped:
 * `consolidar()` needs it to look up which accounts carry those flags before
 * calling `enriquecerMovimientosConAuxiliares`. Optional (unlike `periodo`'s
 * own later append) specifically so the ~35 existing tests that construct
 * this class positionally, one argument short, keep compiling unchanged —
 * only tests that exercise `consolidar()`'s posted entries need to pass a
 * real mock. In the real app this is always injected; a `consolidar()` call
 * with it `undefined` (test-only) simply posts entries with no auxiliares.
 */
@Injectable()
export class LotesFacturacionService {
  constructor(
    @InjectModel(LoteFacturacion.name)
    private readonly lotes: Model<LoteFacturacionDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(ValorRecurrente.name)
    private readonly valoresRecurrentes: Model<ValorRecurrenteDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly periodo: PeriodoService,
    private readonly numeracion: NumeracionService,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables?: Model<CuentaContableDocument>,
  ) {}

  /**
   * Starts (or would-be-resumes) a billing run. Rejects outright if the
   * coproperty already has one in `borrador` or `liquidado` — see the
   * partial unique index on LoteFacturacion for why only one may exist.
   */
  async crear(accountId: string, dto: CrearLoteDto): Promise<LoteContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const yaHayUno = await this.lotes
      .exists({
        coPropertyId,
        status: { $in: ['borrador', 'liquidado'] },
      })
      .exec();
    if (yaHayUno) {
      throw new ConflictException(
        'Ya hay un lote de facturación en curso para esta copropiedad. ' +
          'Consolidalo o esperá a que se resuelva antes de crear uno nuevo.',
      );
    }

    const numero = await this.numeracion.siguienteLote(coPropertyId.toString());

    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();

    const discountGraceDays =
      dto.diasGraciaDescuento ?? copropiedad?.discountGraceDays ?? 0;

    // "Fecha límite para descuento": last day a payment still earns the
    // early-payment discount. The screen pre-fills this and lets the admin
    // override it; only computed here when the caller omits it entirely.
    let discountDeadline: Date;
    if (dto.fechaLimiteDescuento) {
      discountDeadline = new Date(dto.fechaLimiteDescuento);
    } else {
      discountDeadline = new Date(dto.fechaFacturacion);
      discountDeadline.setDate(
        discountDeadline.getDate() + discountGraceDays - 1,
      );
    }

    const creado = await this.lotes.create({
      coPropertyId,
      number: numero,
      status: 'borrador',
      billingDate: new Date(dto.fechaFacturacion),
      dueDate: new Date(dto.fechaVencimiento),
      periodStart: new Date(dto.periodoDesde),
      periodEnd: new Date(dto.periodoHasta),
      earlyPaymentDiscount: dto.descuentoProntoPago ?? 0,
      discountGraceDays,
      lateInterestRate:
        dto.interesMora ??
        (copropiedad?.lateFeeEnabled ? copropiedad.lateFeeInterestRate : 0),
      lateInterestCap:
        dto.topeInteresMora ?? copropiedad?.lateFeeValueLimit ?? null,
      discountDeadline,
      serviceSuspensionDate: dto.fechaSuspension
        ? new Date(dto.fechaSuspension)
        : new Date(dto.periodoHasta),
      generatedBy: accountId,
    });

    return toLote(creado);
  }

  /**
   * Edits an in-progress run's own definition — refused once consolidado,
   * when the period/discount/mora parameters have already produced real
   * Facturas and can no longer change retroactively.
   *
   * Always resets the lote back to `borrador` and clears its `preview`
   * (`summary` along with it): a preview already computed from the OLD
   * parameters no longer matches what changed ones would bill, so showing
   * it as `liquidado` would be a stale table wearing a "confirmed" badge.
   * `adjustments` (novedades) survive the reset — a manual charge against a
   * specific unit/concept has nothing to do with which dates the run covers.
   */
  async actualizar(id: string, dto: ActualizarLoteDto): Promise<LoteContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: id, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote ${id}`);
    }
    if (lote.status === 'consolidado') {
      throw new ConflictException(
        `El lote ${id} ya está consolidado y su definición no puede editarse`,
      );
    }

    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };
    set(
      'billingDate',
      dto.fechaFacturacion ? new Date(dto.fechaFacturacion) : undefined,
    );
    set(
      'dueDate',
      dto.fechaVencimiento ? new Date(dto.fechaVencimiento) : undefined,
    );
    set(
      'periodStart',
      dto.periodoDesde ? new Date(dto.periodoDesde) : undefined,
    );
    set('periodEnd', dto.periodoHasta ? new Date(dto.periodoHasta) : undefined);
    set(
      'discountDeadline',
      dto.fechaLimiteDescuento ? new Date(dto.fechaLimiteDescuento) : undefined,
    );
    set(
      'serviceSuspensionDate',
      dto.fechaSuspension ? new Date(dto.fechaSuspension) : undefined,
    );
    set('earlyPaymentDiscount', dto.descuentoProntoPago);
    set('discountGraceDays', dto.diasGraciaDescuento);
    set('lateInterestRate', dto.interesMora);
    set('lateInterestCap', dto.topeInteresMora);
    doc.status = 'borrador';
    doc.preview = [];
    doc.summary = null;

    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: id, coPropertyId },
        { $set: doc },
        { returnDocument: 'after' },
      )
      .exec();
    if (!actualizado) {
      throw new NotFoundException(`No se encontró el lote ${id}`);
    }
    return toLote(actualizado);
  }

  /**
   * Uploads one-off charges for THIS run only — never written into
   * ValorRecurrente, the standing monthly template. Each row is resolved
   * independently by human-readable identifiers (unit código, concept
   * nombre), the same shape as the Inmuebles bulk import: a row that cannot
   * be resolved is reported and skipped, the rest of the file still loads.
   *
   * ADDITIVE, not a replace: a fresh upload appends its valid rows to
   * whatever `adjustments` already holds (a previous Excel batch, manual
   * lines, recurrente/interes overrides) instead of wiping them — this is
   * what lets a second, unrelated file (e.g. a "multas" batch for owners who
   * skipped the assembly) be uploaded at any point, even after the table has
   * already been hand-edited, without losing anything. Correcting a mistake
   * from an earlier upload is done by editing/zeroing the specific bad row
   * via `editarNovedadLinea`, not by re-uploading the whole file — nothing
   * here de-duplicates, so uploading the exact same file twice double-charges
   * (an accepted risk, same category as typing the same manual line twice).
   */
  async cargarNovedades(
    loteId: string,
    filas: NovedadFilaDto[],
  ): Promise<ResultadoCargaNovedades> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: loteId, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote ${loteId}`);
    }
    if (lote.status === 'consolidado') {
      throw new ConflictException(
        `El lote ${loteId} ya está consolidado y no se le pueden cargar novedades`,
      );
    }
    const errores: ResultadoCargaNovedades['errores'] = [];
    const novedades: Record<string, unknown>[] = [];

    for (const [indice, fila] of filas.entries()) {
      const inmueble = await this.inmuebles
        .findOne({ coPropertyId, code: fila.inmuebleCodigo })
        .exec();
      if (!inmueble) {
        errores.push({
          fila: indice + 1,
          mensaje: `No se encontró el inmueble con código "${fila.inmuebleCodigo}"`,
        });
        continue;
      }

      const concepto = await this.conceptos
        .findOne({
          coPropertyId,
          name: fila.nombreConcepto,
          availableAsNovedad: true,
        })
        .exec();
      if (!concepto) {
        errores.push({
          fila: indice + 1,
          mensaje: `No se encontró el cargo "${fila.nombreConcepto}" o no está habilitado para novedades`,
        });
        continue;
      }

      novedades.push({
        _id: new Types.ObjectId(),
        inmuebleId: inmueble._id,
        conceptoId: concepto._id,
        amount: fila.monto,
        note: fila.observacion?.trim() ? fila.observacion : null,
        overrides: null,
      });
    }

    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId, status: { $ne: 'consolidado' } },
        { $push: { adjustments: { $each: novedades } } },
        { returnDocument: 'after' },
      )
      .exec();

    if (
      actualizado &&
      actualizado.status === 'liquidado' &&
      novedades.length > 0
    ) {
      await this.recalcularYPersistirPreview(actualizado, coPropertyId);
    }

    return { total: filas.length, cargadas: novedades.length, errores };
  }

  /**
   * Adds ONE charge to `adjustments` without touching the rest of the array
   * (unlike `cargarNovedades`'s bulk case, this is always a single row from
   * the Liquidación screen's manual-add form). `dto.overrides` set means this
   * line REPLACES a recurrente/interes line instead of adding a separate one
   * — see NovedadLote's schema comment. If the Lote is already `liquidado`,
   * the preview is recalculated and persisted in this same call, so the
   * table's totals never require a separate manual "recalcular" step.
   */
  async agregarNovedadLinea(
    loteId: string,
    dto: AgregarNovedadLineaDto,
  ): Promise<LoteContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: loteId, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote ${loteId}`);
    }
    if (lote.status === 'consolidado') {
      throw new ConflictException(
        `El lote ${loteId} ya está consolidado y no se le pueden agregar cargos`,
      );
    }

    const inmueble = await this.inmuebles
      .findOne({ _id: dto.inmuebleId, coPropertyId })
      .exec();
    if (!inmueble) {
      throw new NotFoundException(
        `No se encontró el inmueble ${dto.inmuebleId}`,
      );
    }
    const concepto = await this.conceptos
      .findOne({ _id: dto.conceptoId, coPropertyId })
      .exec();
    if (!concepto) {
      throw new NotFoundException(
        `No se encontró el concepto ${dto.conceptoId}`,
      );
    }
    if (dto.overrides === 'interes' && concepto.kind !== 'intereses') {
      throw new ConflictException(
        'Solo el concepto de intereses de esta copropiedad puede reemplazar la mora calculada',
      );
    }
    if (dto.overrides) {
      this.validarUnicidadOverride(
        lote.adjustments,
        dto.inmuebleId,
        dto.conceptoId,
        dto.overrides,
      );
    }

    const nuevaNovedad = {
      _id: new Types.ObjectId(),
      inmuebleId: new Types.ObjectId(dto.inmuebleId),
      conceptoId: new Types.ObjectId(dto.conceptoId),
      amount: dto.amount,
      note: dto.note?.trim() ? dto.note : null,
      overrides: dto.overrides ?? null,
    };

    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId, status: { $ne: 'consolidado' } },
        { $push: { adjustments: nuevaNovedad } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!actualizado) {
      throw new ConflictException(
        `El lote ${loteId} ya no admite cambios (se consolidó mientras se procesaba esta operación)`,
      );
    }

    if (actualizado.status === 'liquidado') {
      return this.recalcularYPersistirPreview(actualizado, coPropertyId);
    }
    return toLote(actualizado);
  }

  /**
   * Edits amount/note on an existing `adjustments` row, addressed by its own
   * `_id` — never `overrides` (the UI never needs to change it: a line
   * without a `novedadId` gets a fresh override via `agregarNovedadLinea`
   * instead, see the Liquidación screen's edit rule). Recalculates and
   * persists `preview` in the same call if the Lote is already `liquidado`.
   */
  async editarNovedadLinea(
    loteId: string,
    novedadId: string,
    dto: EditarNovedadLineaDto,
  ): Promise<LoteContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: loteId, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote ${loteId}`);
    }
    if (lote.status === 'consolidado') {
      throw new ConflictException(
        `El lote ${loteId} ya está consolidado y no se le pueden editar cargos`,
      );
    }
    const novedad = lote.adjustments.find(
      (n) => n._id.toString() === novedadId,
    );
    if (!novedad) {
      throw new NotFoundException(
        `No se encontró la novedad ${novedadId} en el lote ${loteId}`,
      );
    }
    novedad.amount = dto.amount;
    if (dto.note !== undefined) {
      novedad.note = dto.note.trim() ? dto.note : null;
    }

    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId, status: { $ne: 'consolidado' } },
        { $set: { adjustments: lote.adjustments } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!actualizado) {
      throw new ConflictException(
        `El lote ${loteId} ya no admite cambios (se consolidó mientras se procesaba esta operación)`,
      );
    }

    if (actualizado.status === 'liquidado') {
      return this.recalcularYPersistirPreview(actualizado, coPropertyId);
    }
    return toLote(actualizado);
  }

  /**
   * Guard for the 4 document-creation services (Recibos, NotasCredito,
   * NotasDebito, NotasContables): while a billing run is in flight for a
   * coproperty, SaldoCartera and every FacturaPreliminar total can still
   * change under it, so a payment or note posted mid-run could apply against
   * numbers that are about to move — none of the 4 may be created until the
   * run is `consolidado`. Same `$in` list as the partial unique index on
   * LoteFacturacion, kept literal (not `$ne: 'consolidado'`) so the two can
   * never silently diverge if a fourth status is ever added to the enum.
   */
  async exigirSinLoteAbierto(coPropertyId: string): Promise<void> {
    const abierto = await this.lotes
      .findOne({ coPropertyId, status: { $in: ['borrador', 'liquidado'] } })
      .exec();
    if (abierto) {
      throw new ConflictException(
        `Hay un lote de facturación (No. ${abierto.number}) en curso para esta copropiedad. ` +
          'No se pueden registrar recibos ni notas mientras el proceso de facturación no termine.',
      );
    }
  }

  /** Rejects a second override of the same kind for the same inmueble+concepto
   *  — otherwise construirPreview() would have two candidate overrides for
   *  one line and no principled way to pick a winner. Only `agregarNovedadLinea`
   *  calls this: `editarNovedadLinea` never changes `overrides`, so it can
   *  never create this conflict on an existing row. */
  private validarUnicidadOverride(
    adjustments: NovedadLote[],
    inmuebleId: string,
    conceptoId: string,
    overrides: 'recurrente' | 'interes',
  ): void {
    const conflicto = adjustments.find(
      (n) =>
        n.overrides === overrides &&
        n.inmuebleId.toString() === inmuebleId &&
        n.conceptoId.toString() === conceptoId,
    );
    if (conflicto) {
      throw new ConflictException(
        `Ya existe un ajuste de tipo "${overrides}" para este inmueble y concepto en este lote`,
      );
    }
  }

  /** Shared tail of agregarNovedadLinea/editarNovedadLinea/cargarNovedades:
   *  re-derives `preview` from the Lote's current adjustments and persists
   *  it, without touching `status` (already `liquidado` by the time this
   *  runs). Not folded into a single atomic write together with the
   *  adjustments change that triggers it — see the plan's concurrency notes
   *  for why that gap is accepted rather than solved with a transaction. */
  private async recalcularYPersistirPreview(
    lote: LoteFacturacionDocument,
    coPropertyId: Types.ObjectId,
  ): Promise<LoteContract> {
    const preview = await this.construirPreview(lote, coPropertyId);
    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: lote._id, coPropertyId, status: { $ne: 'consolidado' } },
        { $set: { preview } },
        { returnDocument: 'after' },
      )
      .exec();
    return toLote(actualizado ?? lote);
  }

  /**
   * Computes, but does not yet save, one invoice per active unit with a
   * holder — combining its ValorRecurrente template, this run's novedades,
   * and a mora-interest line derived from SaldoCartera. Nothing is written
   * to Factura, SaldoCartera, or AsientoContable here; this only persists
   * the preview and moves the Lote to `liquidado`. Safe to run again later
   * (e.g. from the Liquidación screen's "Generar novedades automáticas"
   * button) — every recurrente/interes line first checks `construirPreview`
   * for a manual override before falling back to the automatic amount, so a
   * re-run reflects edits already made instead of discarding them.
   */
  async liquidar(loteId: string): Promise<LoteContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: loteId, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote ${loteId}`);
    }
    if (lote.status === 'consolidado') {
      throw new ConflictException(
        `El lote ${loteId} ya está consolidado y no puede volver a liquidarse`,
      );
    }

    const preview = await this.construirPreview(lote, coPropertyId);

    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId },
        { $set: { preview, status: 'liquidado' } },
        { returnDocument: 'after' },
      )
      .exec();

    return toLote(actualizado!);
  }

  /**
   * Builds one FacturaPreliminar per active unit with a holder, from
   * ValorRecurrente + adjustments (additive novedades and recurrente/interes
   * overrides) + mora — shared by `liquidar()` (first run) and by
   * `agregarNovedadLinea`/`editarNovedadLinea`/`cargarNovedades` (automatic
   * recalculation once the Lote is already `liquidado`). Re-reads every
   * catalog fresh on each call — deterministic given the current state of
   * ValorRecurrente/adjustments/SaldoCartera, but those can change between
   * calls, so two calls at different times may legitimately differ.
   *
   * A line whose final amount is exactly 0 is never pushed — this is how
   * "edit a line to 0 to remove it" actually removes it from the eventual
   * Factura and AsientoContable, since both are built from this same array.
   */
  private async construirPreview(
    lote: LoteFacturacionDocument,
    coPropertyId: Types.ObjectId,
  ): Promise<Record<string, unknown>[]> {
    const [unidades, conceptos, valoresRecurrentes] = await Promise.all([
      this.inmuebles.find({ coPropertyId, status: 'active' }).exec(),
      // No more active/inactive switch on a concepto (design note on the
      // schema): every declared concept is chargeable, system ones included.
      this.conceptos
        .find({ coPropertyId })
        .populate('cuentaCreditoId', 'code')
        .populate('cuentaDebitoId', 'code')
        .populate('cuentaImpuestoId', 'code')
        .exec(),
      this.valoresRecurrentes.find({ coPropertyId }).exec(),
    ]);
    const conceptoPorId = new Map(conceptos.map((c) => [c._id.toString(), c]));
    const interesConcepto = conceptos.find((c) => c.kind === 'intereses');
    const administracionConcepto = conceptos.find(
      (c) => c.kind === 'administracion',
    );

    // Both fetched in bulk, ONE round-trip each for every unit in the lote —
    // the loop below used to `await` a `terceros.findOne` and a
    // `saldos.find` PER unit, sequentially (a `for...of` with `await`
    // inside never overlaps iterations), so a building of a few hundred
    // units turned into a few hundred sequential round-trips to Atlas
    // before the loop's own work even started. Same "fetch once outside
    // the loop, index by id" shape already used above for `conceptoPorId`.
    const holderIds = unidades
      .map((u) => u.holderId)
      .filter((id): id is Types.ObjectId => id !== null);
    const terceros = holderIds.length
      ? await this.terceros
          .find({ _id: { $in: holderIds }, coPropertyId })
          .exec()
      : [];
    const terceroPorId = new Map(terceros.map((t) => [t._id.toString(), t]));

    // `unidad._id` kept as the real ObjectId instance in this `$in`, never
    // `.toString()`'d: `SaldoCartera`'s `inmuebleId`/`coPropertyId` paths
    // compile as `Mixed` rather than a real ObjectId SchemaType under the
    // installed mongoose/@nestjs-mongoose pair (`@nestjs/mongoose`'s
    // `isMongooseSchemaType()` doesn't recognize `Types.ObjectId` — the BSON
    // value class — as a mongoose SchemaType, so `SchemaFactory` falls back
    // to Mixed for every `@Prop({ type: Types.ObjectId })` field
    // project-wide). A `Mixed` path never auto-casts a query value, so a
    // STRING id here would silently match nothing against the real
    // ObjectIds stored in the collection — this is what made mora silently
    // vanish once before (a whole unit's prior balance read back as empty).
    // Passing real `ObjectId` instances sidesteps the cast entirely: Mongo
    // compares the raw BSON value either way.
    const unidadIds = unidades.map((u) => u._id);
    const saldos = unidadIds.length
      ? await this.saldos
          .find({ coPropertyId, inmuebleId: { $in: unidadIds } })
          .exec()
      : [];
    const saldosPorUnidad = new Map<string, (typeof saldos)[number][]>();
    for (const saldo of saldos) {
      const clave = saldo.inmuebleId.toString();
      const existentes = saldosPorUnidad.get(clave);
      if (existentes) existentes.push(saldo);
      else saldosPorUnidad.set(clave, [saldo]);
    }

    const preview: Record<string, unknown>[] = [];

    for (const unidad of unidades) {
      if (!unidad.holderId) continue;

      const tercero = terceroPorId.get(unidad.holderId.toString()) ?? null;
      const lines: Record<string, unknown>[] = [];

      // Every line's `balanceBefore` below reads from this same
      // per-unit snapshot — including the mora calculation further down,
      // which used to re-fetch this same data later in the loop for no
      // reason (nothing between here and there writes to SaldoCartera;
      // construirPreview never does).
      const saldosUnidad = saldosPorUnidad.get(unidad._id.toString()) ?? [];
      const saldoCorrientePorConcepto = new Map(
        saldosUnidad.map((s) => [s.conceptoId.toString(), s.balance]),
      );

      for (const valor of valoresRecurrentes) {
        if (valor.inmuebleId.toString() !== unidad._id.toString()) continue;
        const concepto = conceptoPorId.get(valor.conceptoId.toString());
        if (!concepto) continue;
        const override = lote.adjustments.find(
          (n) =>
            n.overrides === 'recurrente' &&
            n.inmuebleId.toString() === unidad._id.toString() &&
            n.conceptoId.toString() === valor.conceptoId.toString(),
        );
        const monto = override ? override.amount : valor.amount;
        if (monto === 0) continue;
        lines.push(
          this.aLinea(
            concepto,
            monto,
            'recurrente',
            override?._id ?? null,
            saldoCorrientePorConcepto,
          ),
        );
      }

      for (const novedad of lote.adjustments) {
        if (novedad.inmuebleId.toString() !== unidad._id.toString()) continue;
        // Consumed above/below as an override candidate, not an additive
        // line of its own.
        if (novedad.overrides) continue;
        const concepto = conceptoPorId.get(novedad.conceptoId.toString());
        if (!concepto) continue;
        if (novedad.amount === 0) continue;
        lines.push(
          this.aLinea(
            concepto,
            novedad.amount,
            'novedad',
            novedad._id,
            saldoCorrientePorConcepto,
          ),
        );
      }

      if (interesConcepto) {
        const overrideInteres = lote.adjustments.find(
          (n) =>
            n.overrides === 'interes' &&
            n.inmuebleId.toString() === unidad._id.toString() &&
            n.conceptoId.toString() === interesConcepto._id.toString(),
        );
        if (overrideInteres) {
          // Confirmed with product: a manual mora override has no ceiling —
          // it may land above or below what the automatic formula would
          // have given, same as an override on a recurrente line.
          if (overrideInteres.amount !== 0) {
            lines.push(
              this.aLinea(
                interesConcepto,
                overrideInteres.amount,
                'interes',
                overrideInteres._id,
                saldoCorrientePorConcepto,
              ),
            );
          }
        } else if (administracionConcepto) {
          // Mora is charged on Administración's OWN prior balance — not the
          // unit's total cartera across every concepto (product correction:
          // Multas/Parqueadero/etc. sitting overdue must never inflate the
          // interest base). Read straight from `saldosUnidad`, the pre-cycle
          // snapshot, rather than `saldoCorrientePorConcepto` — that map gets
          // mutated to `balanceAfter` the moment Administración's own
          // recurrente/novedad line is built above, which would double-count
          // this cycle's own charge into "saldo anterior".
          const idAdministracion = administracionConcepto._id.toString();
          const saldoAdministracionAnterior =
            saldosUnidad.find(
              (s) => s.conceptoId.toString() === idAdministracion,
            )?.balance ?? 0;
          // `lateInterestCap` is a MINIMUM overdue balance to bother
          // charging mora at all, not a ceiling on the amount — see the
          // note on `Copropiedad.lateFeeValueLimit`. Null means no
          // threshold: mora is always calculated when the rate is set.
          const minimo = lote.lateInterestCap;
          const alcanzaElMinimo =
            minimo === null || saldoAdministracionAnterior >= minimo;
          if (
            lote.lateInterestRate > 0 &&
            saldoAdministracionAnterior > 0 &&
            alcanzaElMinimo
          ) {
            const valor = Math.round(
              saldoAdministracionAnterior * (lote.lateInterestRate / 100),
            );
            if (valor > 0) {
              lines.push(
                this.aLinea(
                  interesConcepto,
                  valor,
                  'interes',
                  null,
                  saldoCorrientePorConcepto,
                ),
              );
            }
          }
        }
      }

      // A unit can land here with nothing to charge — no ValorRecurrente, no
      // novedad, no interest (or everything present landed at 0). Silently
      // excluding it, like every other per-unit condition in this loop,
      // rather than surfacing it as an error: it is not a data problem, just
      // nothing to invoice.
      if (lines.length === 0) continue;

      // Cargos order (§ "pestaña de Cargos"), not build order: recurrentes,
      // novedades and interés are pushed above in THREE separate loops (the
      // order they're computed in, needed for `balanceBefore`/`balanceAfter`
      // chaining per concepto), which is never the order a building wants to
      // see them in — interés, for instance, is always computed last even
      // though it should print/post second (Administración, Intereses,
      // Multas…). This reorders the already-computed lines by each line's
      // own ConceptoCobro.sortOrder, stable on ties, WITHOUT touching the
      // balances already frozen on each line above. That order also drives
      // `construirMovimientos`'s per-account grouping (asiento.builder.ts),
      // which is why it reaches Consulta de Movimiento Contable too.
      lines.sort((a, b) => {
        const ordenA =
          conceptoPorId.get((a.conceptoId as Types.ObjectId).toString())
            ?.sortOrder ?? 0;
        const ordenB =
          conceptoPorId.get((b.conceptoId as Types.ObjectId).toString())
            ?.sortOrder ?? 0;
        return ordenA - ordenB;
      });

      const subtotal = lines.reduce(
        (acc, l) => acc + (l.baseAmount as number),
        0,
      );
      const totalTax = lines.reduce(
        (acc, l) => acc + (l.taxAmount as number),
        0,
      );

      preview.push({
        inmuebleId: unidad._id,
        unitCode: unidad.code,
        terceroId: tercero?._id ?? null,
        holder: tercero
          ? {
              name: tercero.name,
              identificationType: tercero.identificationType,
              identificationNumber: tercero.identificationNumber,
              identificationVerificationDigit:
                tercero.identificationVerificationDigit,
              address: tercero.address,
              city: tercero.city,
              email: tercero.email,
            }
          : null,
        lines,
        subtotal,
        totalTax,
        total: subtotal + totalTax,
      });
    }

    return preview;
  }

  /**
   * Commits a liquidado Lote: reserves a real number per row, creates the
   * Factura, updates SaldoCartera, and posts the AsientoContable — all for
   * one row, before moving to the next.
   *
   * The period is checked ONCE, up front: every row shares the same
   * `fechaFacturacion`, so one check covers the whole batch. Rows fail
   * independently EXCEPT resolution exhaustion or absence, which is a
   * global blocker — every remaining row would fail identically, so the
   * loop stops there instead of repeating the same failure for each one.
   *
   * The number is reserved OUTSIDE any transaction (per the numbering law,
   * "a document that fails to save leaves a gap, and a gap is the honest
   * outcome") — but Factura + SaldoCartera + AsientoContable for that same
   * row run inside one Mongo transaction, scoped to the row alone. If any
   * of the three fails, all three roll back together: no orphaned Factura,
   * no half-applied balance, no Asiento missing its Factura. The row
   * leaves no trace, so it is automatically retried, cleanly, with a fresh
   * number, the next time this method is called — no standing error, no
   * manual reconciliation, unless the same underlying problem recurs (in
   * which case it is reported again, every time, never silently retried
   * without surfacing it).
   * The Lote reaches `consolidado` only when every previewed row has both
   * a number AND a fully posted Factura/SaldoCartera/AsientoContable —
   * never while any row, past or present, is still incomplete.
   */
  async consolidar(
    loteId: string,
  ): Promise<{ lote: LoteContract; errores: ErrorConsolidacion[] }> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: loteId, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote ${loteId}`);
    }
    // Spec §3.1.1: only a liquidado Lote may be consolidated. Rejects an
    // already-consolidado lote (historical and immutable — a retried
    // request/double-click must not re-create every Factura, re-increment
    // every SaldoCartera, and re-post every AsientoContable) AND a borrador
    // one (never liquidado, so `preview` is empty — consolidating it would
    // burn the coproperty's one active-lote slot on a batch that produced
    // nothing and can never be corrected).
    if (lote.status !== 'liquidado') {
      throw new ConflictException(
        `El lote ${loteId} debe estar liquidado antes de consolidar (estado actual: ${lote.status})`,
      );
    }

    await this.periodo.exigirAbierto(coPropertyId.toString(), lote.billingDate);

    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentasOrden = cuentasOrdenDe(copropiedad);
    const marcasPorCuenta = await this.marcasCuentasPorCodigo(coPropertyId);
    const contextoAuxiliares = {
      centroCosto: copropiedad?.defaultCostCentre ?? null,
      flujoCajaCodigo: copropiedad?.cashFlowCode ?? null,
    };

    // Resume support: if an earlier attempt at this same Lote already
    // created some Facturas before a resolution-exhaustion blocker stopped
    // it, a retry must never re-invoice those units — nothing else in this
    // method (not the {coPropertyId, fullNumber} index, which only stops
    // number reuse) would catch that, and a fresh number would just create
    // a second, duplicate invoice while double-incrementing SaldoCartera.
    //
    // A Factura existing without a matching AsientoContable should no
    // longer occur going forward (Factura + SaldoCartera + AsientoContable
    // now commit or roll back together, in one transaction, per row) — but
    // this guard stays for any orphan left behind by an attempt from before
    // that transaction existed: it is surfaced as a standing error on every
    // retry instead of being silently re-invoiced (a second real DIAN
    // number) or silently left incomplete.
    const facturasExistentes = await this.facturas
      .find({ coPropertyId, loteId, status: 'emitida' })
      .exec();
    const idsExistentes = facturasExistentes.map((f) => f._id.toString());
    const asientosExistentes = await this.asientos
      .find({ coPropertyId, loteId, facturaId: { $in: idsExistentes } })
      .exec();
    // facturaId is typed nullable now (AsientoContable also anchors to a
    // Recibo, with facturaId: null), but this query's own filter —
    // `facturaId: { $in: idsExistentes } }` — guarantees every row returned
    // here has one of those real Factura ids.
    const idsConAsiento = new Set(
      asientosExistentes.map((a) => a.facturaId!.toString()),
    );

    const unidadesYaFacturadas = new Set(
      facturasExistentes.map((f) => f.inmuebleId.toString()),
    );
    const facturaIds: string[] = [];
    let montoTotal = 0;
    const errores: ErrorConsolidacion[] = [];

    for (const factura of facturasExistentes) {
      const facturaId = factura._id.toString();
      facturaIds.push(facturaId);
      if (idsConAsiento.has(facturaId)) {
        montoTotal += factura.total;
        continue;
      }
      const filaEnPreview = lote.preview.findIndex(
        (p) => p.inmuebleId.toString() === factura.inmuebleId.toString(),
      );
      errores.push({
        fila: filaEnPreview >= 0 ? filaEnPreview + 1 : 0,
        inmuebleCodigo: factura.unitCode,
        mensaje: `La factura ${factura.fullNumber} quedó incompleta en un intento anterior (falta su asiento contable) y requiere reconciliación manual`,
      });
    }

    // Bulk pre-fetch every SaldoCartera row this batch's balanceBefore
    // recomputation will need, keyed by `inmuebleId:conceptoId` — same N+1
    // pattern and same fix already applied to construirPreview(). Safe to
    // read once here rather than per-row-per-line: `preview` has one row per
    // unit, and every inmuebleId below is one not already filtered out by
    // `unidadesYaFacturadas`, so no two rows in this loop ever share an
    // inmuebleId — no row's read can be affected by another row's write in
    // this same call. The only staleness this changes is the (already
    // unbounded, already non-transactional) window against a concurrent
    // EXTERNAL write — e.g. a payment posting mid-consolidation — which
    // widens from "immediately before this row" to "the top of this call",
    // not a new category of risk.
    const filasPendientes = lote.preview.filter(
      (p) => !unidadesYaFacturadas.has(p.inmuebleId.toString()),
    );
    const conceptoIdsPendientes = Array.from(
      new Map(
        filasPendientes.flatMap((p) =>
          p.lines.map((l) => [l.conceptoId.toString(), l.conceptoId] as const),
        ),
      ).values(),
    );
    const saldosExistentes =
      filasPendientes.length && conceptoIdsPendientes.length
        ? await this.saldos
            .find({
              coPropertyId,
              inmuebleId: { $in: filasPendientes.map((p) => p.inmuebleId) },
              conceptoId: { $in: conceptoIdsPendientes },
            })
            .exec()
        : [];
    const saldoPorClave = new Map<string, number>(
      saldosExistentes.map((s) => [
        `${s.inmuebleId.toString()}:${s.conceptoId.toString()}`,
        s.balance,
      ]),
    );

    // One round-trip for every number this batch could possibly need,
    // instead of one round-trip per row — `filasPendientes.length` is
    // already exactly the count of rows that will reach the numbering step
    // below (unidadesYaFacturadas-skipped rows never did). May grant fewer
    // than requested if the active resolution runs out partway through;
    // `indiceReservado` below tracks position into whatever was granted.
    const { numeros: numerosReservados } =
      await this.numeracion.reservarBloqueFacturas(
        coPropertyId.toString(),
        filasPendientes.length,
      );
    let indiceReservado = 0;

    // Coarse progress signal, purely for the frontend to poll and show
    // "fila X de Y" instead of a frozen button — a real consolidación can
    // run tens of seconds. Throttled to ~20 writes total regardless of how
    // many rows there are, so this doesn't reintroduce a per-row round-trip
    // cost right after removing one above; never read for anything
    // financial.
    const totalPendientes = filasPendientes.length;
    const intervaloProgreso = Math.max(1, Math.ceil(totalPendientes / 20));
    let filasCompletadas = 0;
    if (totalPendientes > 0) {
      await this.lotes
        .updateOne(
          { _id: loteId, coPropertyId },
          { $set: { progress: { current: 0, total: totalPendientes } } },
        )
        .exec();
    }

    for (const [indice, preliminar] of lote.preview.entries()) {
      if (unidadesYaFacturadas.has(preliminar.inmuebleId.toString())) {
        continue;
      }

      // Spec §6, "Unbalanced AsientoContable": refused before it would be
      // saved — and before a real DIAN number or any document is created
      // for this row. Since construirMovimientos posts one debit and one
      // credit per line, both for that same line's totalAmount, the two
      // sums are equal by construction for any real preliminar — this check
      // is defense-in-depth against a future bug in that builder, not a
      // reachable data problem a re-run fixes, so it is thrown
      // (uncaught, propagates out of consolidar entirely), not recorded as a
      // row error.
      let entries = construirMovimientos(
        preliminar,
        cuentaCartera,
        cuentasOrden,
      );
      if (marcasPorCuenta) {
        entries = enriquecerMovimientosConAuxiliares(entries, marcasPorCuenta, {
          ...contextoAuxiliares,
          terceroCode: preliminar.unitCode,
        });
      }
      const sumaDebitos = entries
        .filter((m) => m.type === 'debito')
        .reduce((acc, m) => acc + m.amount, 0);
      const sumaCreditos = entries
        .filter((m) => m.type === 'credito')
        .reduce((acc, m) => acc + m.amount, 0);
      if (sumaDebitos !== sumaCreditos) {
        throw new Error(
          `Asiento contable desbalanceado para la unidad ${preliminar.unitCode}: débitos ${sumaDebitos} vs créditos ${sumaCreditos}`,
        );
      }

      if (indiceReservado >= numerosReservados.length) {
        // Global blocker: the reserved block ran out — every remaining row
        // would fail identically, same as siguienteFactura's own
        // ConflictException used to trigger before this batching fix.
        errores.push({
          fila: indice + 1,
          inmuebleCodigo: preliminar.unitCode,
          mensaje:
            `Se agotó el rango de numeración disponible para este lote ` +
            `(se pudieron numerar ${numerosReservados.length} de ` +
            `${filasPendientes.length} facturas). Hay que cargar una ` +
            `resolución nueva.`,
        });
        break;
      }
      const numero: NumeroAsignado = numerosReservados[indiceReservado];
      indiceReservado += 1;

      // A real number is already consumed at this point — per the
      // numbering law ("a document that fails to save leaves a gap, and a
      // gap is the honest outcome"), any failure from here on is THIS
      // row's own data problem, not a global blocker: record it and move
      // to the next row instead of aborting the whole batch.
      try {
        // `preliminar.lines[].balanceBefore/After` were computed back at
        // liquidar() time — stale the moment a payment posts in between.
        // The number that actually gets printed on the issued Factura must
        // reflect SaldoCartera as it stood when this consolidar() call
        // started (see `saldoPorClave` above) — so it's recomputed fresh
        // here, per concept, with the same running-map trick as aLinea()
        // for a unit whose lines repeat a concept (e.g. recurrente +
        // novedad on the same concepto).
        const saldoCorrientePorConcepto = new Map<string, number>();
        for (const linea of preliminar.lines) {
          const key = linea.conceptoId.toString();
          let balanceBefore = saldoCorrientePorConcepto.get(key);
          if (balanceBefore === undefined) {
            balanceBefore =
              saldoPorClave.get(`${preliminar.inmuebleId.toString()}:${key}`) ??
              0;
          }
          const balanceAfter = balanceBefore + linea.totalAmount;
          linea.balanceBefore = balanceBefore;
          linea.balanceAfter = balanceAfter;
          saldoCorrientePorConcepto.set(key, balanceAfter);
        }

        // Factura + saldos + asiento run in one Mongo transaction, scoped to
        // THIS row only (never the whole batch — a long-running multi-row
        // transaction risks the driver's default transaction lifetime limit
        // and holds locks far longer than it needs to). Same pattern already
        // used and audited in RecibosService.transaccion(): if anything in
        // here throws, all three writes roll back together — no orphaned
        // Factura, no half-applied SaldoCartera increment, no Asiento
        // missing its Factura. The number already reserved by
        // reservarBloqueFacturas() above is NOT part of this transaction and
        // stays spent either way — that real gap is the same accepted
        // outcome the numbering law already documents ("a gap is the honest
        // outcome"), unchanged by this fix. What changes is that a row whose
        // write phase fails no longer leaves a stuck, permanently-incomplete
        // Factura behind: it leaves nothing, so the next consolidar() call
        // reprocesses it cleanly with a fresh number instead of surfacing a
        // standing "requires manual reconciliation" error forever.
        const session = await this.connection.startSession();
        let facturaCreada!: FacturaDocument;
        try {
          await session.withTransaction(async () => {
            const [factura] = await this.facturas.create(
              [
                {
                  coPropertyId,
                  loteId,
                  inmuebleId: preliminar.inmuebleId,
                  unitCode: preliminar.unitCode,
                  terceroId: preliminar.terceroId,
                  holder: preliminar.holder,
                  // Null when siguienteFactura fell back to the plain FV
                  // consecutivo because this coproperty has no active DIAN
                  // resolution.
                  resolucionId: numero.resolucionId ?? null,
                  prefix: numero.prefijo,
                  number: numero.numero,
                  fullNumber: numero.completo,
                  issueDate: lote.billingDate,
                  dueDate: lote.dueDate,
                  periodStart: lote.periodStart,
                  periodEnd: lote.periodEnd,
                  lines: preliminar.lines,
                  subtotal: preliminar.subtotal,
                  totalTax: preliminar.totalTax,
                  total: preliminar.total,
                  outstandingBalance: preliminar.total,
                  status: 'emitida',
                },
              ],
              { session },
            );
            facturaCreada = factura;

            // One bulkWrite instead of one findOneAndUpdate per line — same
            // atomic, commutative $inc per document as before, just as one
            // round trip instead of N. Safe inside a transaction (unlike
            // Promise.all, which the driver refuses on a single session).
            if (preliminar.lines.length) {
              await this.saldos.bulkWrite(
                preliminar.lines.map((linea) => ({
                  updateOne: {
                    filter: {
                      coPropertyId,
                      inmuebleId: preliminar.inmuebleId,
                      conceptoId: linea.conceptoId,
                    },
                    update: {
                      $inc: { balance: linea.totalAmount },
                      $setOnInsert: {
                        coPropertyId,
                        inmuebleId: preliminar.inmuebleId,
                        conceptoId: linea.conceptoId,
                      },
                    },
                    upsert: true,
                  },
                })),
                { session },
              );
            }

            await this.asientos.create(
              [
                {
                  coPropertyId,
                  loteId,
                  facturaId: factura._id.toString(),
                  date: lote.billingDate,
                  entries,
                },
              ],
              { session },
            );
          });
        } finally {
          await session.endSession();
        }
        // Deliberately outside the withTransaction callback: the driver may
        // retry that callback internally on a transient error, and these are
        // plain in-memory mutations with no transactional undo — living
        // inside the callback would double them on a retry even though only
        // one attempt's writes actually commit.
        facturaIds.push(facturaCreada._id.toString());
        montoTotal += preliminar.total;
      } catch (err) {
        errores.push({
          fila: indice + 1,
          inmuebleCodigo: preliminar.unitCode,
          mensaje: err instanceof Error ? err.message : 'Error desconocido',
        });
      }

      filasCompletadas += 1;
      if (
        filasCompletadas % intervaloProgreso === 0 ||
        filasCompletadas === totalPendientes
      ) {
        await this.lotes
          .updateOne(
            { _id: loteId, coPropertyId },
            {
              $set: {
                progress: { current: filasCompletadas, total: totalPendientes },
              },
            },
          )
          .exec();
      }
    }

    const consolidadoDelTodo = errores.length === 0;
    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId },
        {
          $set: {
            status: consolidadoDelTodo ? 'consolidado' : 'liquidado',
            invoiceIds: facturaIds,
            summary: consolidadoDelTodo
              ? {
                  totalAmount: montoTotal,
                  totalInvoices: facturaIds.length,
                  totalUnits: facturaIds.length,
                }
              : null,
            // The call is over either way (fully consolidado or stopped on
            // an error) — nothing left to poll for.
            progress: null,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();

    // On a partial failure, the persisted status is `liquidado` (see the
    // $set above), which is exactly what the pre-update `lote` already
    // holds — using it here means the returned contract never depends on
    // the round-trip echoing back the write we just issued.
    return {
      lote: consolidadoDelTodo ? toLote(actualizado!) : toLote(lote),
      errores,
    };
  }

  async findAll(): Promise<LoteContract[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documentos = await this.lotes
      .find({ coPropertyId })
      .sort({ number: -1 })
      .exec();
    return documentos.map(toLote);
  }

  async findOne(id: string): Promise<LoteFacturacionDetalle> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documento = await this.lotes
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró el lote ${id}`);
    }
    return toLoteDetalle(documento);
  }

  /** Returns the raw Mongoose document — used by the prefactura PDF, which
   *  needs the parent Lote's dates (billingDate/dueDate/periodStart/
   *  periodEnd) that the mapped contract does not carry per row. */
  async findOneRaw(id: string): Promise<LoteFacturacionDocument> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documento = await this.lotes
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró el lote ${id}`);
    }
    return documento;
  }

  /**
   * Cancels a run that never became real invoices — the one hard delete in
   * this domain, same exception the audit law already carves out for
   * `Inmueble`/`ConceptoCobro`: a `borrador`/`liquidado` lote's `preview` is
   * a computed, throwaway draft, and its `invoiceIds` is still empty —
   * `consolidar` is the only place that ever creates a real `Factura` and
   * fills it in. Refused once consolidado, when that stops being true.
   *
   * Exists mainly to recover from a run started with wrong parameters (a
   * stale Parámetros de Facturación snapshot, say) — the unique partial
   * index only allows one `borrador`/`liquidado` lote per coproperty at a
   * time, so a mistaken one blocks every new attempt until it is gone.
   */
  async cancelar(id: string): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: id, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote ${id}`);
    }
    if (lote.status === 'consolidado') {
      throw new ConflictException(
        `El lote ${id} ya está consolidado y generó facturas reales; no puede cancelarse`,
      );
    }
    await this.lotes.deleteOne({ _id: id, coPropertyId }).exec();
  }

  /** Builds one frozen invoice line from a concept and a base amount —
   *  shared by the recurrente, novedad, and interes cases in
   *  construirPreview(). `accountingIncomeAccount`/`accountingReceivableAccount`
   *  on the resulting line are the concept's CREDIT and DEBIT account codes —
   *  invoicing credits income and debits cartera per concept, per
   *  `construirMovimientos` in asiento.builder.ts. `novedadId` is the
   *  NovedadLote this line came from or was overridden by, null for a
   *  recurrente/interes line never touched manually — see FacturaLinea's
   *  schema comment. */
  /**
   * One `find({coPropertyId})` for the whole chart of accounts, reused for
   * every unit in `consolidar()`'s loop — same "fetch once outside the
   * per-unit loop" shape as `conceptos`/`valoresRecurrentes` in
   * `construirPreview()`. Returns `undefined` (not an empty Map) when
   * `cuentasContables` was never injected — the test-only case documented on
   * this class's own constructor — so callers can tell "no accounts
   * configured" apart from "no lookup available at all" and skip enrichment
   * entirely in the latter.
   */
  private async marcasCuentasPorCodigo(
    coPropertyId: Types.ObjectId,
  ): Promise<Map<string, MarcasCuentaContable> | undefined> {
    if (!this.cuentasContables) return undefined;
    const cuentas = await this.cuentasContables.find({ coPropertyId }).exec();
    return new Map(
      cuentas.map((c) => [
        c.code,
        {
          requiereTercero: c.requiresTercero,
          centroUtilidad: c.profitCenter,
          centroDestino: c.destinationCenter,
          flujoCaja: c.cashFlow,
        },
      ]),
    );
  }

  /**
   * `saldoCorrientePorConcepto` is mutated in place: this line's
   * `balanceAfter` becomes the map's new value for its concept, so a
   * second line against the same concept on the same unit (e.g. a novedad
   * on top of the recurrente charge) stacks on top of THIS line's result,
   * not the value read at the start of the unit's loop.
   */
  private aLinea(
    concepto: {
      _id: Types.ObjectId;
      name: string;
      kind: string;
      taxRate: number;
      cuentaCreditoId: { code: string } | Types.ObjectId | null;
      cuentaDebitoId: { code: string } | Types.ObjectId | null;
      cuentaImpuestoId: { code: string } | Types.ObjectId | null;
    },
    baseAmount: number,
    origen: 'recurrente' | 'novedad' | 'interes',
    novedadId: Types.ObjectId | null = null,
    saldoCorrientePorConcepto: Map<string, number>,
  ): Record<string, unknown> {
    const taxAmount = Math.round(baseAmount * (concepto.taxRate / 100));
    const totalAmount = baseAmount + taxAmount;
    const key = concepto._id.toString();
    const balanceBefore = saldoCorrientePorConcepto.get(key) ?? 0;
    const balanceAfter = balanceBefore + totalAmount;
    saldoCorrientePorConcepto.set(key, balanceAfter);
    return {
      conceptoId: concepto._id,
      conceptName: concepto.name,
      conceptKind: concepto.kind,
      accountingIncomeAccount: codigoDeCuentaContable(concepto.cuentaCreditoId),
      accountingReceivableAccount: codigoDeCuentaContable(
        concepto.cuentaDebitoId,
      ),
      accountingTaxAccount: codigoDeCuentaContable(concepto.cuentaImpuestoId),
      source: origen,
      novedadId,
      baseAmount,
      taxRate: concepto.taxRate,
      taxAmount,
      totalAmount,
      balanceBefore,
      balanceAfter,
    };
  }
}
