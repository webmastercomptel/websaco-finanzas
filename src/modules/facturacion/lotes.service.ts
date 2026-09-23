import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue, QueueEvents } from 'bullmq';
import { Connection, Model, Types } from 'mongoose';
import type { AnyBulkWriteOperation } from 'mongoose';
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
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoDocument,
} from '../../database/schemas/facturacion/saldo-total-documento.schema';
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
import type { CrearFacturaIndividualDto } from './dto/crear-factura-individual.dto';
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
  type CuentasOrden,
  type ContextoAuxiliares,
} from './asiento.builder';
import { calcularDescuentoProntoPago } from '../../common/facturacion/descuento-pronto-pago.util';
import {
  NOMBRE_COLA_CONSOLIDACION,
  NOMBRE_TRABAJO_CONSOLIDACION,
  EVENTOS_COLA_CONSOLIDACION,
  type DatosTrabajoConsolidacion,
  type ResultadoConsolidacion,
} from './colas/consolidacion.constants';

/** Rows per Mongo transaction and concurrent transactions in flight during
 *  `consolidar()`'s write step — see `ejecutarConsolidacion()`'s own
 *  docblock. Conservative defaults for a shared/free-tier Atlas cluster;
 *  safe to raise once the cluster has dedicated resources. */
const TAMANO_TANDA_CONSOLIDACION = 20;
const CONCURRENCIA_TANDAS_CONSOLIDACION = 4;

/** One row of `LoteFacturacionDocument['preview']` — the exact type
 *  `lote.preview.entries()` always yielded, kept as an alias rather than
 *  re-importing `FacturaPreliminar` so it stays byte-identical to the
 *  Mongoose subdocument type every call site already relied on. */
type FilaPreliminar = LoteFacturacionDocument['preview'][number];

/** `indiceEnPreview` is the row's real position in `lote.preview` — kept
 *  explicit rather than re-derived later via `findIndex(inmuebleId match)`,
 *  which silently mis-reports `fila` whenever two preview rows happen to
 *  share an `inmuebleId` (a Factura Individual test fixture, say); the
 *  original per-row loop never had this problem because `fila` came
 *  straight from the loop's own index. */
type FilaNumerada = {
  preliminar: FilaPreliminar;
  numero: NumeroAsignado;
  indiceEnPreview: number;
};

/** Everything a tanda's rows share and need to write against — assembled
 *  once per `ejecutarConsolidacion()` call, read (never mutated except via
 *  `sumarMonto`/`registrarNumero`/`errores`/`facturaIds`) by every tanda,
 *  safe under `conLimiteDeConcurrencia`'s concurrency since none of those
 *  mutations ever interleave mid-statement (Node's single-threaded event
 *  loop, not true parallelism). */
type ContextoTanda = {
  loteId: string;
  lote: LoteFacturacionDocument;
  coPropertyId: Types.ObjectId;
  cuentaCartera: string;
  cuentasOrden: CuentasOrden | null;
  marcasPorCuenta: Map<string, MarcasCuentaContable> | undefined;
  contextoAuxiliares: Pick<
    ContextoAuxiliares,
    'centroCosto' | 'flujoCajaCodigo'
  >;
  saldoPorClave: Map<string, number>;
  copropiedad: CopropiedadDocument | null;
  errores: ErrorConsolidacion[];
  registrarNumero: (numero: number, completo: string) => void;
  facturaIds: string[];
  sumarMonto: (monto: number) => void;
};

/** One row's fully-prepared write payload — everything
 *  `prepararFilaParaConsolidar` computes in memory, ready for
 *  `procesarTanda` to insert alongside every other row in its tanda. */
type FilaPreparada = {
  facturaId: Types.ObjectId;
  facturaDoc: Record<string, unknown>;
  saldoTotalDoc: Record<string, unknown>;
  saldosOps: AnyBulkWriteOperation<SaldoCartera>[];
  carteraDocs: Record<string, unknown>[];
  asientoDoc: Record<string, unknown>;
  total: number;
  numero: number;
  fullNumber: string;
};

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
 *
 * `resoluciones`, `presentacionDocumento`, and `facturasService` were
 * APPENDED and later REMOVED again: they backed the step where
 * `consolidar()` itself froze each issued Factura's presentation tree
 * (`documentDefinition`) at issuance time. Under the pdfmake +
 * frontend-render model that step moved OUT of `consolidar()` entirely —
 * `solicitar-generacion`/`confirmar-generacion` are now separate, explicit
 * actions the frontend triggers later, batched, from `LotesController`
 * (which injects its own `PresentacionDocumentoService`/`FacturasService`
 * for that). Once `consolidar()` no longer referenced them, they were dead
 * constructor params with no runtime purpose — removed outright, along with
 * updating the handful of test constructions that never actually passed
 * them (all stop at `cuentasContables`, the last argument any test needs).
 *
 * `cola`/`eventosCola` were APPENDED, both optional, when `consolidar()`'s
 * actual work moved onto a BullMQ job instead of running inline on the HTTP
 * request thread — see `ejecutarConsolidacion()`'s own docblock. Optional
 * for the exact same reason `cuentasContables` is: the ~50 hand-rolled
 * constructions in this class's own spec never pass either one, and don't
 * need to — `consolidar()` falls back to calling `ejecutarConsolidacion()`
 * directly, in-process, whenever `cola`/`eventosCola` is undefined, which
 * is exactly the path every existing test already exercises. In the real
 * app, Nest DI always injects both.
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
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
    @InjectModel(SaldoTotalDocumento.name)
    private readonly saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
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
    @InjectQueue(NOMBRE_COLA_CONSOLIDACION)
    private readonly cola?: Queue<
      DatosTrabajoConsolidacion,
      ResultadoConsolidacion
    >,
    @Inject(EVENTOS_COLA_CONSOLIDACION)
    private readonly eventosCola?: QueueEvents,
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

    // Catches exactly the real bug this guards against: a typo in
    // `fechaFacturacion` (an extra/wrong digit in the year, e.g. "9202"
    // instead of "2026") is still a syntactically valid ISO date — nothing
    // in `CrearLoteDto` catches it. A new cycle must always pick up where
    // the last CONSOLIDATED one left off, one calendar month later; no
    // validation at all when the coproperty has never consolidated a lote
    // (first cycle ever is free to land anywhere). Placed before
    // `numeracion.siguienteLote()` — a refusal here must cost no consumed
    // consecutivo, same "a refusal costs no session" discipline as every
    // other pre-transaction guard in this codebase.
    const ultimoConsolidado = await this.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    if (ultimoConsolidado) {
      const fechaFacturacion = new Date(dto.fechaFacturacion);
      const periodoEsperado = new Date(
        Date.UTC(
          ultimoConsolidado.billingDate.getUTCFullYear(),
          ultimoConsolidado.billingDate.getUTCMonth() + 1,
          1,
        ),
      );
      const mismoPeriodo =
        fechaFacturacion.getUTCFullYear() ===
          periodoEsperado.getUTCFullYear() &&
        fechaFacturacion.getUTCMonth() === periodoEsperado.getUTCMonth();
      if (!mismoPeriodo) {
        throw new BadRequestException(
          'La fecha de facturación debe corresponder al período siguiente ' +
            `al último ciclo generado (${String(periodoEsperado.getUTCMonth() + 1).padStart(2, '0')}/${periodoEsperado.getUTCFullYear()})`,
        );
      }
    }

    const numero = await this.numeracion.siguienteLote(coPropertyId.toString());

    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();

    const discountGraceDays =
      dto.diasGraciaDescuento ?? copropiedad?.discountGraceDays ?? 0;

    // The percentage and the fixed value are mutually exclusive at the
    // Parámetros de Facturación level (Copropiedad's own rule): only
    // inherit from there when the caller sent NEITHER explicitly — same
    // "caller wins, else inherit" pattern as `discountGraceDays` above and
    // `lateInterestRate` below. `discountPercentage` wins whenever it is
    // `> 0`; `discountFixedValue` is the fallback, taken only when the
    // percentage is absent.
    let earlyPaymentDiscount = dto.descuentoProntoPago;
    let earlyPaymentDiscountFixedValue = dto.valorFijoDescuentoProntoPago;
    if (
      earlyPaymentDiscount === undefined &&
      earlyPaymentDiscountFixedValue === undefined &&
      copropiedad?.discountEnabled
    ) {
      if (copropiedad.discountPercentage > 0) {
        earlyPaymentDiscount = copropiedad.discountPercentage;
      } else if (copropiedad.discountFixedValue > 0) {
        earlyPaymentDiscountFixedValue = copropiedad.discountFixedValue;
      }
    }

    // "Fecha límite para descuento": last day a payment still earns the
    // early-payment discount. The screen pre-fills this and lets the admin
    // override it; only computed here when the caller omits it entirely.
    let discountDeadline: Date;
    if (dto.fechaLimiteDescuento) {
      discountDeadline = new Date(dto.fechaLimiteDescuento);
    } else {
      // UTC arithmetic, matching the rest of this codebase's convention
      // for pure calendar dates — `dto.fechaFacturacion` parses as UTC
      // midnight, and mixing in local `getDate`/`setDate` reads/writes the
      // wrong calendar day on a machine not itself running in UTC (e.g.
      // local dev in Colombia, UTC-5). Harmless today only because "add N
      // whole days" happens to be translation-invariant under a fixed,
      // DST-free offset — not a guarantee worth relying on.
      discountDeadline = new Date(dto.fechaFacturacion);
      discountDeadline.setUTCDate(
        discountDeadline.getUTCDate() + discountGraceDays - 1,
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
      earlyPaymentDiscount: earlyPaymentDiscount ?? 0,
      earlyPaymentDiscountFixedValue: earlyPaymentDiscountFixedValue ?? 0,
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
   * Starts a "Factura Individual" — a one-off Lote scoped to exactly one
   * inmueble, created outside the normal monthly cycle (e.g. a unit that
   * missed the regular run, or a special one-time charge). Shares the SAME
   * status lifecycle and every other route (`agregarNovedadLinea`,
   * `liquidar`, `consolidar`, `cancelar`, the prefactura/factura PDFs) as an
   * ordinary lote — the only thing this method does differently from
   * `crear()` above is how it picks the run's dates/parameters and that it
   * stamps `inmuebleId`.
   *
   * ALWAYS pinned to the CURRENT period — copied verbatim from the most
   * recently consolidado lote (billingDate, dueDate, period, discount/mora
   * settings, all of it), never freely chosen by the caller: product
   * decision was explicit that this kind of invoice "no puede quedar
   * suelta, ni pertenecer a ningún periodo anterior". Refuses outright when
   * the coproperty has never consolidated a lote — there is no "current
   * period" yet to attach to.
   *
   * Still subject to the same one-lote-in-flight guard as `crear()` (the
   * partial unique index on `status`) — a Factura Individual mid-edit blocks
   * a new monthly run starting, and vice versa, same as any two ordinary
   * lotes would.
   */
  async crearIndividual(
    accountId: string,
    dto: CrearFacturaIndividualDto,
  ): Promise<LoteContract> {
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

    const inmueble = await this.inmuebles
      .findOne({ _id: dto.inmuebleId, coPropertyId })
      .exec();
    if (!inmueble) {
      throw new NotFoundException(
        `No se encontró el inmueble ${dto.inmuebleId}`,
      );
    }

    const ultimoConsolidado = await this.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    if (!ultimoConsolidado) {
      throw new BadRequestException(
        'Esta copropiedad todavía no tiene un período de facturación ' +
          'consolidado — una Factura Individual necesita un período actual ' +
          'al cual pertenecer.',
      );
    }

    const numero = await this.numeracion.siguienteLote(coPropertyId.toString());

    const creado = await this.lotes.create({
      coPropertyId,
      number: numero,
      status: 'borrador',
      inmuebleId: new Types.ObjectId(dto.inmuebleId),
      // Todo lo demás, copiado tal cual del período actual — nunca
      // recalculado desde los parámetros vigentes de la copropiedad, para
      // que esta factura quede indistinguible de una emitida por el lote
      // real de ese mismo ciclo.
      billingDate: ultimoConsolidado.billingDate,
      dueDate: ultimoConsolidado.dueDate,
      periodStart: ultimoConsolidado.periodStart,
      periodEnd: ultimoConsolidado.periodEnd,
      earlyPaymentDiscount: ultimoConsolidado.earlyPaymentDiscount,
      earlyPaymentDiscountFixedValue:
        ultimoConsolidado.earlyPaymentDiscountFixedValue,
      discountGraceDays: ultimoConsolidado.discountGraceDays,
      lateInterestRate: ultimoConsolidado.lateInterestRate,
      lateInterestCap: ultimoConsolidado.lateInterestCap,
      discountDeadline: ultimoConsolidado.discountDeadline,
      serviceSuspensionDate: ultimoConsolidado.serviceSuspensionDate,
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
    set('earlyPaymentDiscountFixedValue', dto.valorFijoDescuentoProntoPago);
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
    if (lote.inmuebleId && lote.inmuebleId.toString() !== dto.inmuebleId) {
      throw new ConflictException(
        `El lote ${loteId} es una Factura Individual del inmueble ` +
          `${lote.inmuebleId.toString()} — no admite cargos de otro inmueble`,
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

  /**
   * The most recently consolidated billing run for a coproperty — the
   * closest thing this system has to "the current billing period". `number`
   * is a strictly increasing per-coproperty sequence assigned at `crear()`
   * time, so it orders runs correctly even if `billingDate` were ever
   * backdated. Returns `null` for a coproperty that has never consolidated a
   * lote — callers must treat that as "nothing to validate against", not an
   * error.
   */
  async obtenerUltimoConsolidado(
    coPropertyId: string,
  ): Promise<LoteFacturacionDocument | null> {
    return this.lotes
      .findOne({ coPropertyId, status: 'consolidado' })
      .sort({ number: -1 })
      .exec();
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
    // A Factura Individual (`lote.inmuebleId` set) scopes the whole preview
    // to that one unit, and — product decision — never auto-populates from
    // ValorRecurrente or the automatic mora formula: every charge on it is
    // added by hand via `agregarNovedadLinea`, precisely so it can never
    // silently repeat a charge the NEXT regular cycle would also produce.
    // `esIndividual` gates both below.
    // `!= null` (loose) on purpose — catches both a real `null` (the
    // schema's own default) and `undefined` (a plain object fixture in a
    // test, or any document read before this field existed), so an ordinary
    // whole-coproperty lote never accidentally takes the individual branch.
    const esIndividual = lote.inmuebleId != null;
    const [unidades, conceptos, valoresRecurrentes] = await Promise.all([
      this.inmuebles
        .find({
          coPropertyId,
          status: 'active',
          ...(lote.inmuebleId ? { _id: lote.inmuebleId } : {}),
        })
        .exec(),
      // No more active/inactive switch on a concepto (design note on the
      // schema): every declared concept is chargeable, system ones included.
      this.conceptos
        .find({ coPropertyId })
        .populate('cuentaCreditoId', 'code')
        .populate('cuentaDebitoId', 'code')
        .populate('cuentaImpuestoId', 'code')
        .exec(),
      esIndividual
        ? Promise.resolve([])
        : this.valoresRecurrentes.find({ coPropertyId }).exec(),
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
        } else if (administracionConcepto && !esIndividual) {
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
              // The PDF prints one address, not a list — see the product
              // decision on `TitularCongelado.email`, 2026-09-22.
              email: tercero.emails[0] ?? null,
              phone: tercero.phone,
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
   * The external entry point — unchanged contract. `consolidar()` used to
   * DO the work; now it enqueues one BullMQ job that carries it out
   * (`ejecutarConsolidacion()`, below) and awaits that job's result via
   * `Job.waitUntilFinished`, so `POST :id/consolidar` still returns the
   * exact same `{ lote, errores }` shape it always did — only WHERE the
   * heavy lifting executes moved, off this HTTP request's own thread and
   * onto a worker, reusing the Redis this app already had wired ahead of
   * BullMQ.
   *
   * Falls back to calling `ejecutarConsolidacion()` directly, in-process,
   * whenever `cola`/`eventosCola` is undefined — see the constructor's own
   * docblock: that's the ~50 hand-rolled test constructions in this
   * class's own spec, never real production traffic.
   */
  async consolidar(
    loteId: string,
  ): Promise<{ lote: LoteContract; errores: ErrorConsolidacion[] }> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    if (!this.cola || !this.eventosCola) {
      return this.ejecutarConsolidacion(loteId, coPropertyId);
    }

    const trabajo = await this.cola.add(NOMBRE_TRABAJO_CONSOLIDACION, {
      loteId,
      coPropertyId: coPropertyId.toString(),
    });
    return trabajo.waitUntilFinished(this.eventosCola);
  }

  /**
   * Commits a liquidado Lote: reserves a real number per row, creates the
   * Factura, updates SaldoCartera, and posts the AsientoContable.
   *
   * The period is checked ONCE, up front: every row shares the same
   * `fechaFacturacion`, so one check covers the whole batch. Rows fail
   * independently EXCEPT resolution exhaustion or absence, which is a
   * global blocker — every remaining row would fail identically, so
   * numbering stops there instead of repeating the same failure for each
   * one.
   *
   * The number is reserved OUTSIDE any transaction (per the numbering law,
   * "a document that fails to save leaves a gap, and a gap is the honest
   * outcome") — but Factura + SaldoCartera + AsientoContable run inside one
   * Mongo transaction PER TANDA (a fixed-size chunk of rows,
   * `TAMANO_TANDA_CONSOLIDACION`), not per row: this used to be one
   * transaction per invoice, sequential, which meant a lote of a few
   * hundred units paid the FULL network round-trip cost of 5 collection
   * writes plus a majority-write-concern commit, ONE ROW AT A TIME — the
   * dominant cost of a slow `consolidar()` call. Batching amortizes those 6
   * round-trips over `TAMANO_TANDA_CONSOLIDACION` rows at once
   * (`procesarTanda`), and independent tandas run with bounded concurrency
   * (`conLimiteDeConcurrencia`, `CONCURRENCIA_TANDAS_CONSOLIDACION` at a
   * time) since no two tandas ever touch the same document — each row's
   * `inmuebleId` is unique within the lote, and every Factura `_id` is
   * pre-assigned in JS before any write reaches Mongo.
   *
   * The tradeoff a bigger transaction unit accepts: failure isolation moves
   * from per-row to per-tanda. If any write in a tanda's transaction fails,
   * the WHOLE tanda rolls back — no orphaned Factura, no half-applied
   * balance, no Asiento missing its Factura, same guarantee as before, just
   * scoped to `TAMANO_TANDA_CONSOLIDACION` rows instead of one. Every row in
   * a rolled-back tanda leaves no trace, so all of them are automatically
   * retried, cleanly, with fresh numbers, the next time this runs — same
   * "no standing error unless the problem recurs" behavior as before, just
   * coarser-grained.
   *
   * The Lote reaches `consolidado` only when every previewed row has both
   * a number AND a fully posted Factura/SaldoCartera/AsientoContable —
   * never while any row, past or present, is still incomplete.
   */
  async ejecutarConsolidacion(
    loteId: string,
    coPropertyId: Types.ObjectId,
    job?: Job<DatosTrabajoConsolidacion, ResultadoConsolidacion>,
  ): Promise<ResultadoConsolidacion> {
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
    // now commit or roll back together, in one transaction, per tanda) —
    // but this guard stays for any orphan left behind by an attempt from
    // before that transaction existed: it is surfaced as a standing error
    // on every retry instead of being silently re-invoiced (a second real
    // DIAN number) or silently left incomplete.
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

    // Tracks the lowest/highest invoice `number` seen across both loops
    // below (resumed-from-a-prior-attempt Facturas here, freshly created
    // ones further down) so `resumen.primerNumero`/`ultimoNumero` reflects
    // the real numbering range regardless of Mongo's find() order or which
    // attempt created which row. Discarded on any error path — summary is
    // only ever persisted when `consolidadoDelTodo`.
    let numeroMinimo: number | null = null;
    let numeroMaximo: number | null = null;
    let primerNumeroCompleto: string | null = null;
    let ultimoNumeroCompleto: string | null = null;
    const registrarNumero = (numero: number, completo: string): void => {
      if (numeroMinimo === null || numero < numeroMinimo) {
        numeroMinimo = numero;
        primerNumeroCompleto = completo;
      }
      if (numeroMaximo === null || numero > numeroMaximo) {
        numeroMaximo = numero;
        ultimoNumeroCompleto = completo;
      }
    };

    for (const factura of facturasExistentes) {
      const facturaId = factura._id.toString();
      facturaIds.push(facturaId);
      registrarNumero(factura.number, factura.fullNumber);
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
    // Paired with each row's REAL position in `lote.preview` up front —
    // `filaIndiceDe` below reads it back for error reporting instead of
    // re-deriving it later via `findIndex(inmuebleId match)`, which
    // silently mis-reports `fila` whenever two preview rows share an
    // `inmuebleId` (see `FilaNumerada`'s own docblock).
    const filasPendientesConIndice = lote.preview
      .map((preliminar, indiceEnPreview) => ({ preliminar, indiceEnPreview }))
      .filter(
        ({ preliminar }) =>
          !unidadesYaFacturadas.has(preliminar.inmuebleId.toString()),
      );
    const filasPendientes = filasPendientesConIndice.map((f) => f.preliminar);
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
    // than requested if the active resolution runs out partway through.
    const { numeros: numerosReservados } =
      await this.numeracion.reservarBloqueFacturas(
        coPropertyId.toString(),
        filasPendientes.length,
      );

    // Pairs each pending row with the number it will use, in the SAME
    // order `filasPendientes` already carries. A row past the end of
    // `numerosReservados` never gets processed this call — the active
    // resolution ran out, and every remaining row would fail identically,
    // same "global blocker" `consolidar()` always had.
    const filasNumeradas = filasPendientesConIndice
      .slice(0, numerosReservados.length)
      .map(({ preliminar, indiceEnPreview }, indice) => ({
        preliminar,
        indiceEnPreview,
        numero: numerosReservados[indice],
      }));

    if (filasPendientes.length > numerosReservados.length) {
      const primeraSinNumero =
        filasPendientesConIndice[numerosReservados.length];
      errores.push({
        fila: primeraSinNumero.indiceEnPreview + 1,
        inmuebleCodigo: primeraSinNumero.preliminar.unitCode,
        mensaje:
          `Se agotó el rango de numeración disponible para este lote ` +
          `(se pudieron numerar ${numerosReservados.length} de ` +
          `${filasPendientes.length} facturas). Hay que cargar una ` +
          `resolución nueva.`,
      });
    }

    // Coarse progress signal, purely for the frontend to poll and show
    // "fila X de Y" instead of a frozen button — a real consolidación can
    // run tens of seconds. Reported both into `lote.progress` (Mongo, the
    // field the API contract has always exposed) and into the job's own
    // BullMQ progress (Redis, cheap, available for a future push-based
    // UI). Throttled to ~20 writes total regardless of how many tandas run.
    const totalPendientes = filasNumeradas.length;
    const intervaloProgreso = Math.max(1, Math.ceil(totalPendientes / 20));
    let filasCompletadas = 0;
    const informarProgreso = async (): Promise<void> => {
      await job?.updateProgress({
        current: filasCompletadas,
        total: totalPendientes,
      });
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
    };
    if (totalPendientes > 0) {
      await informarProgreso();
    }

    // Splits the numbered rows into fixed-size tandas — one Mongo
    // transaction per tanda instead of one per row — run with bounded
    // concurrency. See this method's own docblock for the round-trip
    // math and the failure-isolation tradeoff this accepts.
    const tandas: (typeof filasNumeradas)[] = [];
    for (
      let i = 0;
      i < filasNumeradas.length;
      i += TAMANO_TANDA_CONSOLIDACION
    ) {
      tandas.push(filasNumeradas.slice(i, i + TAMANO_TANDA_CONSOLIDACION));
    }

    const contextoTanda: ContextoTanda = {
      loteId,
      lote,
      coPropertyId,
      cuentaCartera,
      cuentasOrden,
      marcasPorCuenta,
      contextoAuxiliares,
      saldoPorClave,
      copropiedad,
      errores,
      registrarNumero,
      facturaIds,
      sumarMonto: (monto: number): void => {
        montoTotal += monto;
      },
    };

    await this.conLimiteDeConcurrencia(
      tandas,
      CONCURRENCIA_TANDAS_CONSOLIDACION,
      async (tanda) => {
        await this.procesarTanda(tanda, contextoTanda);
        filasCompletadas += tanda.length;
        if (
          filasCompletadas % intervaloProgreso === 0 ||
          filasCompletadas === totalPendientes
        ) {
          await informarProgreso();
        }
      },
    );

    // Presentation generation is no longer triggered here — under the
    // pdfmake + frontend-render model, `solicitar-generacion`/
    // `confirmar-generacion` are separate, explicit actions the frontend
    // calls later (batch, on `LotesController`), never something
    // `consolidar()` does internally. See the plan this implements
    // ("Migración de PDF de documentos financieros a frontend").
    const consolidadoDelTodo = errores.length === 0;
    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId },
        {
          $set: {
            status: consolidadoDelTodo ? 'consolidado' : 'liquidado',
            invoiceIds: facturaIds,
            summary:
              consolidadoDelTodo && primerNumeroCompleto && ultimoNumeroCompleto
                ? {
                    totalAmount: montoTotal,
                    totalInvoices: facturaIds.length,
                    totalUnits: facturaIds.length,
                    firstInvoiceNumber: primerNumeroCompleto,
                    lastInvoiceNumber: ultimoNumeroCompleto,
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

  /**
   * Runs `tarea` over every item in `items`, at most `concurrencia`
   * promises in flight at once — a manual worker-pool since this codebase
   * carries no bounded-concurrency dependency for something this small.
   */
  private async conLimiteDeConcurrencia<T>(
    items: T[],
    concurrencia: number,
    tarea: (item: T) => Promise<void>,
  ): Promise<void> {
    let siguiente = 0;
    const trabajador = async (): Promise<void> => {
      while (siguiente < items.length) {
        const indice = siguiente;
        siguiente += 1;
        await tarea(items[indice]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrencia, items.length) }, () =>
        trabajador(),
      ),
    );
  }

  /**
   * Processes ONE tanda of already-numbered rows inside a single Mongo
   * transaction — the same 5-collection write `consolidar()` always did
   * per row, just batched across every row in this tanda. Every new
   * document's `_id` is assigned in JS before the transaction starts
   * (never left for Mongo to generate) specifically so
   * SaldoTotalDocumento/CarteraPorDocumento/AsientoContable can reference
   * a Factura's real id from inside the SAME insertMany/bulkWrite calls
   * that create it — no round-trip spent reading anything back mid-way.
   *
   * A thrown "asiento desbalanceado" (defense-in-depth — see
   * `prepararFilaParaConsolidar`) is NOT caught here: it propagates out of
   * the whole tanda, and from there out of `consolidar()` entirely, same
   * as it always did.
   *
   * Any OTHER failure — the transaction can't commit, a duplicate key,
   * whatever — rolls back this tanda's transaction as a whole and records
   * EVERY row in it as its own `ErrorConsolidacion` (same message,
   * different `fila`/`inmuebleCodigo`): the tradeoff a bigger transaction
   * unit accepts versus the old one-row-per-transaction isolation — a
   * retry simply reprocesses the whole tanda with fresh numbers, nothing
   * is left half-done.
   */
  private async procesarTanda(
    tanda: FilaNumerada[],
    ctx: ContextoTanda,
  ): Promise<void> {
    const preparados = tanda.map(({ preliminar, numero }) =>
      this.prepararFilaParaConsolidar(preliminar, numero, ctx),
    );

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.facturas.insertMany(
          preparados.map((p) => p.facturaDoc),
          { session },
        );
        await this.saldoTotalDocumento.insertMany(
          preparados.map((p) => p.saldoTotalDoc),
          { session },
        );
        const opsSaldos = preparados.flatMap((p) => p.saldosOps);
        if (opsSaldos.length) {
          await this.saldos.bulkWrite(opsSaldos, { session });
        }
        const docsCartera = preparados.flatMap((p) => p.carteraDocs);
        if (docsCartera.length) {
          await this.carteraPorDocumento.insertMany(docsCartera, { session });
        }
        await this.asientos.insertMany(
          preparados.map((p) => p.asientoDoc),
          { session },
        );
      });
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : 'Error desconocido';
      for (const { preliminar, indiceEnPreview } of tanda) {
        ctx.errores.push({
          fila: indiceEnPreview + 1,
          inmuebleCodigo: preliminar.unitCode,
          mensaje,
        });
      }
      return;
    } finally {
      await session.endSession();
    }

    for (const p of preparados) {
      ctx.facturaIds.push(p.facturaId.toString());
      ctx.sumarMonto(p.total);
      ctx.registrarNumero(p.numero, p.fullNumber);
    }
  }

  /**
   * All the in-memory prep `consolidar()` always did per row — movements,
   * the debits-equal-credits check, balance recompute, the pronto-pago
   * discount, and the actual document shapes — WITHOUT touching the
   * database. `procesarTanda` batches the actual writes across every row
   * this returns for its tanda.
   *
   * The unbalanced-asiento check stays a plain, uncaught `throw` — see
   * `procesarTanda`'s own docblock for why that's deliberate.
   */
  private prepararFilaParaConsolidar(
    preliminar: FilaPreliminar,
    numero: NumeroAsignado,
    ctx: ContextoTanda,
  ): FilaPreparada {
    let entries = construirMovimientos(
      preliminar,
      ctx.cuentaCartera,
      ctx.cuentasOrden,
    );
    if (ctx.marcasPorCuenta) {
      entries = enriquecerMovimientosConAuxiliares(
        entries,
        ctx.marcasPorCuenta,
        {
          ...ctx.contextoAuxiliares,
          terceroCode: preliminar.unitCode,
        },
      );
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

    // `preliminar.lines[].balanceBefore/After` were computed back at
    // liquidar() time — stale the moment a payment posts in between. The
    // number that actually gets printed on the issued Factura must reflect
    // SaldoCartera as it stood when this consolidar() call started (see
    // `saldoPorClave`) — so it's recomputed fresh here, per concept, with
    // the same running-map trick as aLinea() for a unit whose lines repeat
    // a concept (e.g. recurrente + novedad on the same concepto).
    const saldoCorrientePorConcepto = new Map<string, number>();
    for (const linea of preliminar.lines) {
      const key = linea.conceptoId.toString();
      let balanceBefore = saldoCorrientePorConcepto.get(key);
      if (balanceBefore === undefined) {
        balanceBefore =
          ctx.saldoPorClave.get(`${preliminar.inmuebleId.toString()}:${key}`) ??
          0;
      }
      const balanceAfter = balanceBefore + linea.totalAmount;
      linea.balanceBefore = balanceBefore;
      linea.balanceAfter = balanceAfter;
      saldoCorrientePorConcepto.set(key, balanceAfter);
    }

    const { discountAmount, discountDeadline } = calcularDescuentoProntoPago(
      preliminar.lines,
      ctx.lote.earlyPaymentDiscount,
      ctx.lote.earlyPaymentDiscountFixedValue,
      ctx.lote.discountDeadline,
      ctx.copropiedad?.discountAppliesWithLateFee ?? false,
    );

    const facturaId = new Types.ObjectId();

    const facturaDoc = {
      _id: facturaId,
      coPropertyId: ctx.coPropertyId,
      loteId: ctx.loteId,
      inmuebleId: preliminar.inmuebleId,
      unitCode: preliminar.unitCode,
      terceroId: preliminar.terceroId,
      holder: preliminar.holder,
      // Null when siguienteFactura fell back to the plain FV consecutivo
      // because this coproperty has no active DIAN resolution.
      resolucionId: numero.resolucionId ?? null,
      prefix: numero.prefijo,
      number: numero.numero,
      fullNumber: numero.completo,
      issueDate: ctx.lote.billingDate,
      dueDate: ctx.lote.dueDate,
      periodStart: ctx.lote.periodStart,
      periodEnd: ctx.lote.periodEnd,
      lines: preliminar.lines,
      subtotal: preliminar.subtotal,
      totalTax: preliminar.totalTax,
      total: preliminar.total,
      outstandingBalance: preliminar.total,
      discountAmount,
      discountDeadline,
      status: 'emitida' as const,
    };

    // Seeds this Factura's own atomically-guarded total-balance row — see
    // `SaldoTotalDocumento`'s own docblock for why this can't just be
    // `sum(CarteraPorDocumento.saldoPendiente)` computed on demand.
    const saldoTotalDoc = {
      coPropertyId: ctx.coPropertyId,
      tipoDocumento: 'FV' as const,
      documentoId: facturaId,
      total: preliminar.total,
      saldoPendiente: preliminar.total,
    };

    // Same atomic, commutative $inc per document as before — just batched
    // into ONE bulkWrite per tanda instead of one per row.
    const saldosOps = preliminar.lines.map((linea) => ({
      updateOne: {
        filter: {
          coPropertyId: ctx.coPropertyId,
          inmuebleId: preliminar.inmuebleId,
          conceptoId: linea.conceptoId,
        },
        update: {
          $inc: { balance: linea.totalAmount },
          $setOnInsert: {
            coPropertyId: ctx.coPropertyId,
            inmuebleId: preliminar.inmuebleId,
            conceptoId: linea.conceptoId,
          },
        },
        upsert: true,
      },
    }));

    // Seeds this Factura's own row in the per-document cartera ledger —
    // one per line, alongside `SaldoCartera` above (kept as an
    // independent, redundantly-maintained audit control; see
    // `CarteraPorDocumento`'s own docblock).
    const carteraDocs = preliminar.lines.map((linea) => ({
      coPropertyId: ctx.coPropertyId,
      inmuebleId: preliminar.inmuebleId,
      tipoDocumento: 'FV' as const,
      documentoId: facturaId,
      conceptoId: linea.conceptoId,
      montoOriginal: linea.totalAmount,
      saldoPendiente: linea.totalAmount,
      saldoAnterior: linea.balanceBefore,
      saldoNuevo: linea.balanceAfter,
    }));

    // Documento cruce self-reference (FV, this SAME factura's own número)
    // — a second enrichment pass because the earlier one (right after
    // `construirMovimientos`, used for the debits-equal-credits check
    // above) runs before `numero` exists on the very first call site of
    // this method. Re-running tercero/centroCosto/flujoCaja here too is
    // harmless — same inputs, same idempotent result — the only thing this
    // pass actually changes is documentoCruce.
    const entriesFinal = ctx.marcasPorCuenta
      ? enriquecerMovimientosConAuxiliares(entries, ctx.marcasPorCuenta, {
          ...ctx.contextoAuxiliares,
          terceroCode: preliminar.unitCode,
          documentoCruce: { tipo: 'FV', numero: numero.numero },
        })
      : entries;

    const asientoDoc = {
      coPropertyId: ctx.coPropertyId,
      loteId: ctx.loteId,
      facturaId: facturaId.toString(),
      date: ctx.lote.billingDate,
      entries: entriesFinal,
    };

    return {
      facturaId,
      facturaDoc,
      saldoTotalDoc,
      saldosOps,
      carteraDocs,
      asientoDoc,
      total: preliminar.total,
      numero: numero.numero,
      fullNumber: numero.completo,
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
          requiereDocumentoCruce: c.requiresCrossDocument,
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
      // Seeds this line's own pending-balance tracker — see
      // `FacturaLinea.remainingAmount`'s own comment. Harmless on a
      // FacturaPreliminar (never persisted); on the real Factura this is
      // what every future application against this concepto decrements.
      remainingAmount: totalAmount,
      balanceBefore,
      balanceAfter,
    };
  }
}
