import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  LoteFacturacion,
  LoteFacturacionDocument,
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
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { PeriodoService } from '../../common/contabilidad/periodo.service';
import {
  NumeracionService,
  type NumeroAsignado,
} from '../../common/numeracion/numeracion.service';
import type { LoteFacturacion as LoteContract } from '../../contracts';
import { toLote } from './lotes.mapper';
import type { CrearLoteDto } from './dto/crear-lote.dto';
import type { NovedadFilaDto } from './dto/cargar-novedades.dto';
import type { ResultadoCargaNovedades } from '../../contracts';
import type { ErrorConsolidacion } from '../../contracts';
import { construirMovimientos, CUENTA_SIN_ASIGNAR } from './asiento.builder';

/**
 * CANONICAL CONSTRUCTOR — pinned here and never changed by a later task in
 * this plan. `terceros` and `copropiedades` are unused until Tasks 9 and 10
 * respectively, but declaring the full shape now means every later task only
 * adds methods, never edits this parameter list — the single biggest source
 * of silent test/implementation drift in a plan built task-by-task. Every
 * test in Tasks 6, 7, 9, and 10 constructs this class with all twelve
 * arguments, in this exact order, using `{} as never` for whichever ones
 * that particular test does not exercise.
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

    const creado = await this.lotes.create({
      coPropertyId,
      number: numero,
      status: 'borrador',
      billingDate: new Date(dto.fechaFacturacion),
      dueDate: new Date(dto.fechaVencimiento),
      periodStart: new Date(dto.periodoDesde),
      periodEnd: new Date(dto.periodoHasta),
      earlyPaymentDiscount: dto.descuentoProntoPago ?? 0,
      discountGraceDays: dto.diasGraciaDescuento ?? 0,
      lateInterestRate: dto.interesMora ?? 0,
      lateInterestCap: dto.topeInteresMora ?? null,
      generatedBy: accountId,
    });

    return toLote(creado);
  }

  /**
   * Uploads one-off charges for THIS run only — never written into
   * ValorRecurrente, the standing monthly template. Each row is resolved
   * independently by human-readable identifiers (unit código, concept
   * nombre), the same shape as the Inmuebles bulk import: a row that cannot
   * be resolved is reported and skipped, the rest of the file still loads.
   * A fresh upload REPLACES the Lote's previous novedades, since re-uploading
   * a corrected file is the expected flow, not accumulating duplicates.
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
        .findOne({ coPropertyId, name: fila.nombreConcepto, active: true })
        .exec();
      if (!concepto) {
        errores.push({
          fila: indice + 1,
          mensaje: `No se encontró el cargo "${fila.nombreConcepto}"`,
        });
        continue;
      }

      novedades.push({
        inmuebleId: inmueble._id,
        conceptoId: concepto._id,
        amount: fila.monto,
        note: fila.observacion?.trim() ? fila.observacion : null,
      });
    }

    await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId },
        { $set: { adjustments: novedades } },
        { new: true },
      )
      .exec();

    return { total: filas.length, cargadas: novedades.length, errores };
  }

  /**
   * Computes, but does not yet save, one invoice per active unit with a
   * holder — combining its ValorRecurrente template, this run's novedades,
   * and a mora-interest line derived from SaldoCartera. Nothing is written
   * to Factura, SaldoCartera, or AsientoContable here; this only persists
   * the preview and moves the Lote to `liquidado`. Re-running liquidar
   * simply overwrites the previous preview.
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

    const [unidades, conceptos, valoresRecurrentes] = await Promise.all([
      this.inmuebles.find({ coPropertyId, status: 'active' }).exec(),
      this.conceptos.find({ coPropertyId, active: true }).exec(),
      this.valoresRecurrentes.find({ coPropertyId }).exec(),
    ]);
    const conceptoPorId = new Map(conceptos.map((c) => [c._id.toString(), c]));

    const preview: Record<string, unknown>[] = [];

    for (const unidad of unidades) {
      if (!unidad.holderId) continue;

      const tercero = await this.terceros
        .findOne({ _id: unidad.holderId, coPropertyId })
        .exec();
      const lines: Record<string, unknown>[] = [];

      for (const valor of valoresRecurrentes) {
        if (valor.inmuebleId.toString() !== unidad._id.toString()) continue;
        const concepto = conceptoPorId.get(valor.conceptoId.toString());
        if (!concepto) continue;
        lines.push(this.aLinea(concepto, valor.amount, 'recurrente'));
      }

      for (const novedad of lote.adjustments) {
        if (novedad.inmuebleId.toString() !== unidad._id.toString()) continue;
        const concepto = conceptoPorId.get(novedad.conceptoId.toString());
        if (!concepto) continue;
        lines.push(this.aLinea(concepto, novedad.amount, 'novedad'));
      }

      const saldosUnidad = await this.saldos
        .find({ coPropertyId, inmuebleId: unidad._id.toString() })
        .exec();
      const saldoTotal = saldosUnidad.reduce((acc, s) => acc + s.balance, 0);
      const interesConcepto = conceptos.find((c) => c.kind === 'intereses');
      if (interesConcepto && lote.lateInterestRate > 0 && saldoTotal > 0) {
        const bruto = saldoTotal * (lote.lateInterestRate / 100);
        const tope = lote.lateInterestCap;
        const valor = Math.round(tope !== null ? Math.min(bruto, tope) : bruto);
        if (valor > 0) {
          lines.push(this.aLinea(interesConcepto, valor, 'interes'));
        }
      }

      if (lines.length === 0) continue;

      const subtotal = lines.reduce(
        (acc, l) => acc + (l.baseAmount as number),
        0,
      );
      const totalTax = lines.reduce(
        (acc, l) => acc + (l.taxAmount as number),
        0,
      );

      preview.push({
        inmuebleId: unidad._id.toString(),
        unitCode: unidad.code,
        terceroId: tercero?._id.toString() ?? null,
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

    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId },
        { $set: { preview, status: 'liquidado' } },
        { new: true },
      )
      .exec();

    return toLote(actualizado!);
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
   * A row whose Factura was created but whose SaldoCartera/AsientoContable
   * write then failed is recorded as its own per-row error, not retried
   * automatically on the next call (that would mean either duplicating a
   * real DIAN number or re-running a non-idempotent `$inc`) — it surfaces
   * as a standing error until a human reconciles it.
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

    // Resume support: if an earlier attempt at this same Lote already
    // created some Facturas before a resolution-exhaustion blocker (or a
    // per-row write failure below) stopped it, a retry must never re-invoice
    // those units — nothing else in this method (not the
    // {coPropertyId, fullNumber} index, which only stops number reuse) would
    // catch that, and a fresh number would just create a second, duplicate
    // invoice while double-incrementing SaldoCartera.
    //
    // A Factura existing is not by itself proof the row finished: the
    // per-row catch below can leave one behind with no matching
    // SaldoCartera increment or AsientoContable. Re-running that increment
    // isn't safe (it isn't idempotent — that's the same reason this whole
    // method has no transaction), and re-invoicing the unit would mint a
    // second real DIAN number for it, so an incomplete row is surfaced as a
    // standing error on every retry instead — never silently completed and
    // never silently retried.
    const facturasExistentes = await this.facturas
      .find({ coPropertyId, loteId, status: 'emitida' })
      .exec();
    const idsExistentes = facturasExistentes.map((f) => f._id.toString());
    const asientosExistentes = await this.asientos
      .find({ coPropertyId, loteId, facturaId: { $in: idsExistentes } })
      .exec();
    const idsConAsiento = new Set(
      asientosExistentes.map((a) => a.facturaId.toString()),
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

    for (const [indice, preliminar] of lote.preview.entries()) {
      if (unidadesYaFacturadas.has(preliminar.inmuebleId.toString())) {
        continue;
      }

      // Spec §6, "Unbalanced AsientoContable": refused before it would be
      // saved — and before a real DIAN number or any document is created
      // for this row. This checks a bug in the posting logic itself, not a
      // data problem a re-run fixes, so it is thrown (uncaught, propagates
      // out of consolidar entirely), not recorded as a row error.
      const entries = construirMovimientos(preliminar, cuentaCartera);
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

      let numero: NumeroAsignado;
      try {
        numero = await this.numeracion.siguienteFactura(
          coPropertyId.toString(),
        );
      } catch (err) {
        // Global blocker: every remaining row would fail the same way.
        errores.push({
          fila: indice + 1,
          inmuebleCodigo: preliminar.unitCode,
          mensaje: err instanceof Error ? err.message : 'Error desconocido',
        });
        break;
      }

      // A real number is already consumed at this point — per the
      // numbering law ("a document that fails to save leaves a gap, and a
      // gap is the honest outcome"), any failure from here on is THIS
      // row's own data problem, not a global blocker: record it and move
      // to the next row instead of aborting the whole batch.
      try {
        const factura = await this.facturas.create({
          coPropertyId,
          loteId,
          inmuebleId: preliminar.inmuebleId,
          unitCode: preliminar.unitCode,
          terceroId: preliminar.terceroId,
          holder: preliminar.holder,
          // Always set on this path — only siguienteDocumento's internal
          // documents (RC/NC/ND/NT) omit it. See NumeroAsignado's own comment.
          resolucionId: numero.resolucionId!,
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
        });
        facturaIds.push(factura._id.toString());
        montoTotal += preliminar.total;

        for (const linea of preliminar.lines) {
          await this.saldos
            .findOneAndUpdate(
              {
                coPropertyId,
                inmuebleId: preliminar.inmuebleId,
                conceptoId: linea.conceptoId,
              },
              {
                $inc: { balance: linea.totalAmount },
                $setOnInsert: {
                  coPropertyId,
                  inmuebleId: preliminar.inmuebleId,
                  conceptoId: linea.conceptoId,
                },
              },
              { upsert: true },
            )
            .exec();
        }

        await this.asientos.create({
          coPropertyId,
          loteId,
          facturaId: factura._id.toString(),
          date: lote.billingDate,
          entries,
        });
      } catch (err) {
        errores.push({
          fila: indice + 1,
          inmuebleCodigo: preliminar.unitCode,
          mensaje: err instanceof Error ? err.message : 'Error desconocido',
        });
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
          },
        },
        { new: true },
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

  async findOne(id: string): Promise<LoteContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documento = await this.lotes
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró el lote ${id}`);
    }
    return toLote(documento);
  }

  /** Builds one frozen invoice line from a concept and a base amount —
   *  shared by the recurrente, novedad, and interes cases in liquidar(). */
  private aLinea(
    concepto: {
      _id: Types.ObjectId;
      name: string;
      kind: string;
      taxRate: number;
      accountingIncomeAccount: string | null;
    },
    baseAmount: number,
    origen: 'recurrente' | 'novedad' | 'interes',
  ): Record<string, unknown> {
    const taxAmount = Math.round(baseAmount * (concepto.taxRate / 100));
    return {
      conceptoId: concepto._id,
      conceptName: concepto.name,
      conceptKind: concepto.kind,
      accountingIncomeAccount: concepto.accountingIncomeAccount,
      source: origen,
      baseAmount,
      taxRate: concepto.taxRate,
      taxAmount,
      totalAmount: baseAmount + taxAmount,
    };
  }
}
