import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  NotaContable,
  NotaContableDocument,
} from '../../database/schemas/notas-contables/nota-contable.schema';
import {
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  SaldoDocumentoOrigen,
  SaldoDocumentoOrigenDocument,
} from '../../database/schemas/recibos/saldo-documento-origen.schema';
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
  SaldoInicial,
  SaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { fechaNotaCredito } from '../notas-credito/notas-credito.mapper';
import { fechaNotaContable } from '../notas-contables/notas-contables.mapper';
import {
  calcularDocumentosConSaldoAFecha,
  finDelDiaCorte,
} from './cartera-historica.util';
import type {
  MovimientoEstadoCuenta,
  PeriodoFacturado,
  RespuestaEstadoCuenta,
  TipoDocumentoKardex,
} from '../../contracts';
import type { ConsultarEstadoCuentaDto } from './dto/consultar-estado-cuenta.dto';

type RowRaw = {
  fecha: Date;
  tipo: TipoDocumentoKardex;
  numeroCompleto: string;
  concepto: string;
  cargo: number | null;
  abono: number | null;
  categoria: 'pago' | 'descuento' | null;
};

/** The document's own type name — never a computed sentence mixing in its
 *  número, which has its own column now. */
const ETIQUETA_DOCUMENTO: Record<TipoDocumentoKardex, string> = {
  FC: 'Factura de Venta',
  RC: 'Recibo',
  NC: 'Nota Crédito',
  ND: 'Nota Débito',
  NT: 'Nota Contable',
  NA: 'Nota de Anticipo',
  SI: 'Saldo Inicial',
};

/** Compute days overdue AS OF `corte`: max(0, floor((corte - vence) / day)).
 *  UTC truncation, never local — same formula `VencimientosCarteraService`/
 *  `CarteraGeneralService` each keep their own copy of, for the same
 *  reason: a local `setHours` would silently shift every count by a day on
 *  a machine not itself running in UTC. `corte` here is always `periodEnd`
 *  — the statement's OWN cutoff date, never the real "today" (see
 *  `RespuestaEstadoCuenta.estado`'s own docblock). */
const calcularDiasMora = (vence: Date, corte: Date): number => {
  const c = new Date(corte);
  c.setUTCHours(0, 0, 0, 0);
  const v = new Date(vence);
  v.setUTCHours(0, 0, 0, 0);
  const diff = c.getTime() - v.getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
};

/**
 * Read-only owner's statement service. Generates a document-shaped statement
 * for one inmueble and one billing period, intended to be printed or saved as
 * PDF and handed to a propietario.
 */
@Injectable()
export class EstadoCuentaService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(NotaAnticipo.name)
    private readonly notasAnticipo: Model<NotaAnticipoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(SaldoDocumentoOrigen.name)
    private readonly saldoDocumentoOrigen: Model<SaldoDocumentoOrigenDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    @InjectModel(SaldoInicial.name)
    private readonly saldosIniciales: Model<SaldoInicialDocument>,
  ) {}

  /**
   * Every distinct (periodStart, periodEnd) pair from that inmueble's
   * Facturas, sorted most-recent-first.
   */
  async findPeriodos(inmuebleId: string): Promise<PeriodoFacturado[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const oid = new Types.ObjectId(inmuebleId);

    // Not status-filtered — see the main `findAll` fetch below for why an
    // anulada Factura still belongs in this inmueble's own history.
    const facturas = await this.facturas
      .find({ coPropertyId, inmuebleId: oid })
      .sort({ periodStart: -1 })
      .exec();

    // Deduplicate by (periodStart, periodEnd) — at most one per lote run
    const seen = new Set<string>();
    const result: PeriodoFacturado[] = [];
    for (const f of facturas) {
      const key = `${f.periodStart.toISOString()}|${f.periodEnd.toISOString()}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          periodStart: f.periodStart.toISOString(),
          periodEnd: f.periodEnd.toISOString(),
        });
      }
    }
    return result;
  }

  /**
   * Full owner's statement for one inmueble and one billing period.
   */
  async findAll(
    query: ConsultarEstadoCuentaDto,
  ): Promise<RespuestaEstadoCuenta> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(query.inmuebleId);
    const desde = new Date(query.periodStart);
    const hasta = new Date(query.periodEnd);

    // Fetch inmueble for code + holderId
    const inmueble = await this.inmuebles
      .findOne({ _id: inmuebleId, coPropertyId })
      .exec();
    const inmuebleCodigo = inmueble?.code ?? '';
    const holderId = inmueble?.holderId ?? null;

    // Resolve propietario name
    let propietario: string | null = null;
    if (holderId) {
      const tercero = await this.terceros
        .findOne({ _id: holderId, coPropertyId })
        .exec();
      propietario = tercero?.name ?? null;
    }

    // Fetch copropiedad for contact info
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    const copropiedadTelefono = copropiedad?.phone ?? null;
    const copropiedadEmail = copropiedad?.email ?? null;

    // Find the period's own Factura for fechaEmision — not status-filtered,
    // same reasoning as the main fetch below: an anulada Factura still
    // really was issued on this date, and printing the period's start date
    // instead (the fallback below) would be a worse answer than the truth.
    const facturaPeriodo = await this.facturas
      .findOne({
        coPropertyId,
        inmuebleId,
        periodStart: desde,
        periodEnd: hasta,
      })
      .exec();

    const fechaEmision =
      facturaPeriodo?.issueDate?.toISOString() ?? desde.toISOString();

    // Step 1: fetch all documents for this inmueble (no date filter — see spec §5)
    //
    // Facturas: NOT status-filtered, on purpose. An anulada Factura is
    // voided by creating a full-amount Nota Crédito against it
    // (AnularFacturaService) — that note's own value already lands in
    // `descuentosAjustes` below (NotaCredito is fetched unfiltered too, a
    // few lines down). Excluding the Factura's own `cargosDelMes` charge
    // while still counting its reversal in `descuentosAjustes` doesn't just
    // hide a row — it understates `saldoActual` by the exact voided amount
    // (a credit with no matching charge to net against). Keeping the
    // Factura here makes the statement read as "charged X, then credited X
    // back" — correct history, and a correct balance.
    const [
      facturas,
      notasDebito,
      saldosIniciales,
      recibos,
      notasCredito,
      notasContables,
      notasAnticipo,
    ] = await Promise.all([
      this.facturas.find({ coPropertyId, inmuebleId }).exec(),
      this.notasDebito
        .find({ coPropertyId, inmuebleId, status: 'emitida' })
        .exec(),
      // Not status-filtered by `activo` — same reasoning as Facturas above:
      // an `anulado` Saldo Inicial is voided by reversing whatever balance
      // was still pending (never a full credit note), so excluding it here
      // would silently drop history that's still true (it WAS imported).
      this.saldosIniciales.find({ coPropertyId, inmuebleId }).exec(),
      this.recibos.find({ coPropertyId, inmuebleId }).exec(),
      this.notasCredito.find({ coPropertyId, inmuebleId }).exec(),
      this.notasContables
        .find({ coPropertyId, inmuebleId, status: 'activo' })
        .exec(),
      this.notasAnticipo.find({ coPropertyId, inmuebleId }).exec(),
    ]);

    // Step 2: fetch active applications for RC + NC + NA sources — omitting
    // Notas de Anticipo here was a real bug: their applications (crediting
    // whatever cargo the leftover anticipo settled) never appeared on this
    // statement at all, silently understating anticiposAplicados.
    const sourceIds = [
      ...recibos.map((r) => r._id),
      ...notasCredito.map((nc) => nc._id),
      ...notasAnticipo.map((na) => na._id),
    ];
    const aplicaciones = sourceIds.length
      ? await this.aplicaciones
          .find({
            coPropertyId,
            sourceId: { $in: sourceIds },
            status: 'activa',
          })
          .exec()
      : [];

    // Recibos activos — reused both for the period-scoped "Recibo" rows in
    // Detalle de Movimientos / `pagosDelMes` (Step 7) and for Anticipos
    // Pendientes (Step 8b), same "active" definition as `Recibo.status`.
    const recibosActivos = recibos.filter((r) => r.status === 'activo');

    // Step 3: build lookup maps. Each carries the source document's own
    // business date — never `AplicacionCartera.appliedAt`, which is always
    // `new Date()` at cruce time (needed for the accounting entry, which
    // posts at the real instant) and can land in a different period than
    // the date the user actually declared for the payment.
    const reciboMap = new Map(
      recibos.map((r) => [
        r._id.toString(),
        { fullNumber: r.fullNumber, fecha: r.receivedDate },
      ]),
    );
    const ncMap = new Map(
      notasCredito.map((nc) => [
        nc._id.toString(),
        { fullNumber: nc.fullNumber, fecha: fechaNotaCredito(nc) },
      ]),
    );
    const naMap = new Map(
      notasAnticipo.map((na) => [
        na._id.toString(),
        { fullNumber: na.fullNumber, fecha: na.issueDate },
      ]),
    );

    // Step 4: build raw rows
    const rows: RowRaw[] = [];

    // Facturas → débito
    for (const f of facturas) {
      rows.push({
        fecha: f.issueDate,
        tipo: 'FC',
        numeroCompleto: f.fullNumber,
        concepto: ETIQUETA_DOCUMENTO.FC,
        cargo: f.total,
        abono: null,
        categoria: null,
      });
    }

    // Notas Débito → débito
    for (const nd of notasDebito) {
      rows.push({
        fecha: nd.issueDate,
        tipo: 'ND',
        numeroCompleto: nd.fullNumber,
        concepto: ETIQUETA_DOCUMENTO.ND,
        cargo: nd.total,
        abono: null,
        categoria: null,
      });
    }

    // Saldos Iniciales → débito, dated by their own historical `fecha`
    // (always before this coproperty's first real period in this system —
    // see `SaldoInicial`'s own schema docblock) — `numeroOriginal` in place
    // of a `fullNumber` it never had.
    for (const si of saldosIniciales) {
      rows.push({
        fecha: si.fecha,
        tipo: 'SI',
        numeroCompleto: si.numeroOriginal,
        concepto: ETIQUETA_DOCUMENTO.SI,
        cargo: si.total,
        abono: null,
        categoria: null,
      });
    }

    // AplicacionCartera → crédito with categoria
    for (const app of aplicaciones) {
      const sourceType = app.sourceType;
      const origen =
        sourceType === 'RC'
          ? reciboMap.get(app.sourceId.toString())
          : sourceType === 'NA'
            ? naMap.get(app.sourceId.toString())
            : ncMap.get(app.sourceId.toString());
      const sourceNumber = origen?.fullNumber ?? app.sourceId.toString();
      const fecha = origen?.fecha ?? app.appliedAt;
      const etiqueta = ETIQUETA_DOCUMENTO[sourceType];

      // `amountApplied` on an RC/NA application is cash PLUS whatever
      // discount it absorbed (`discountApplied`) — automatic pronto pago OR
      // a user-confirmed payment shortfall sent to Descuentos (RecibosService
      // .crear()'s `confirmarDescuentoFaltante`, `cruce.util.ts`'s own
      // `descuentoLinea`) — the factura is credited the full amount, the
      // source's cash side is smaller either way, and this screen has no way
      // to tell the two apart (nor does it need to — "Descuento Aplicado"
      // covers both). Counting the whole thing as "pago" would overstate
      // what the propietario actually paid, so the discount portion gets its
      // own row/categoria — same bucket a Nota Crédito's own discount
      // already uses — leaving only real cash under "pago". A Nota de
      // Anticipo runs through the exact same cruce machinery
      // (`ejecutarAplicacionManual`/`Fifo`) as a Recibo, so it can carry a
      // discount too — never just RC.
      const montoDescuento =
        sourceType === 'RC' || sourceType === 'NA'
          ? (app.discountApplied ?? 0)
          : 0;
      const montoCash = app.amountApplied - montoDescuento;

      if (montoCash > 0) {
        rows.push({
          fecha,
          tipo: sourceType,
          numeroCompleto: sourceNumber,
          concepto: etiqueta,
          cargo: null,
          abono: montoCash,
          categoria: sourceType === 'NC' ? 'descuento' : 'pago',
        });
      }
      if (montoDescuento > 0) {
        rows.push({
          fecha,
          tipo: sourceType,
          numeroCompleto: sourceNumber,
          concepto: 'Descuento Aplicado',
          cargo: null,
          abono: montoDescuento,
          categoria: 'descuento',
        });
      }
    }

    // Notas Contables → TWO rows each (débito + crédito, net zero).
    // `fechaNotaContable` — never `createdAt` directly: that's the real
    // server instant the record was INSERTED, which can land in a
    // completely different month than the note's own declared business
    // date (bug real reportado: una nota fechada en junio apareció con
    // fecha de septiembre porque se guardó/editó ese día).
    for (const nc of notasContables) {
      const fecha = fechaNotaContable(nc);
      rows.push({
        fecha,
        tipo: 'NT',
        numeroCompleto: nc.fullNumber,
        concepto: ETIQUETA_DOCUMENTO.NT,
        cargo: nc.monto,
        abono: null,
        categoria: null,
      });
      rows.push({
        fecha,
        tipo: 'NT',
        numeroCompleto: nc.fullNumber,
        concepto: ETIQUETA_DOCUMENTO.NT,
        cargo: null,
        abono: nc.monto,
        categoria: null,
      });
    }

    // Step 5: sort by fecha ascending
    rows.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

    // Step 6: saldoAnterior — sum of movements strictly before periodStart
    const saldoAnterior = rows
      .filter((r) => r.fecha < desde)
      .reduce((sum, r) => sum + (r.cargo ?? 0) - (r.abono ?? 0), 0);

    // Step 7: movements within [periodStart, periodEnd].
    //
    // Recibo ("RC") "pago" rows built off `AplicacionCartera` cruces (Step
    // 4) are dropped here and replaced by ONE row per ACTIVE Recibo whose
    // OWN `receivedDate` falls in the period, at its full GROSS
    // `receivedAmount` — never the applied/net `montoCash` a cruce leaves
    // behind. Those per-cruce rows stay in `rows` above (unfiltered) purely
    // so `saldoAnterior` (Step 6, computed over ALL history strictly before
    // `desde`) keeps using the pre-existing applied/net logic untouched —
    // only this period's own displayed detail and `pagosDelMes` change. A
    // Recibo split across N cruces within this same period collapses from N
    // rows to exactly one; a Recibo received in the period with zero
    // cruces yet (fully parked as anticipo) now gets a row too, which it
    // never did before (`RespuestaEstadoCuenta.pagosDelMes`'s own docblock).
    const recibosDelPeriodo = recibosActivos.filter(
      (r) => r.receivedDate >= desde && r.receivedDate <= hasta,
    );
    const filasRecibo: RowRaw[] = recibosDelPeriodo.map((r) => ({
      fecha: r.receivedDate,
      tipo: 'RC',
      numeroCompleto: r.fullNumber,
      concepto: ETIQUETA_DOCUMENTO.RC,
      cargo: null,
      abono: r.receivedAmount,
      categoria: 'pago',
    }));

    const movimientosEnPeriodo = rows
      .filter((r) => r.fecha >= desde && r.fecha <= hasta)
      .filter((r) => !(r.tipo === 'RC' && r.categoria === 'pago'))
      .concat(filasRecibo)
      .sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

    // Step 8: bucket into summary numbers. Nota Contable rows (tipo 'NT')
    // are excluded here even though one of their two paired rows carries a
    // `cargo` — they net to zero and never change what the inmueble owes,
    // so they must stay purely informational (spec §2/§5).
    const cargosDelMes = movimientosEnPeriodo
      .filter((r) => r.tipo !== 'NT')
      .reduce((sum, r) => sum + (r.cargo ?? 0), 0);
    // Gross cash actually received this period — one Recibo, one row
    // (`filasRecibo` above), never the applied/net `montoCash` a cruce
    // leaves behind.
    const pagosDelMes = filasRecibo.reduce((sum, r) => sum + (r.abono ?? 0), 0);
    // Isolated from `pagosDelMes` on purpose: this is the applied/net
    // portion of a Nota de Anticipo cruce — an OLD, already-counted Recibo's
    // leftover balance reapplied later (`NotaAnticipo`'s own schema
    // docblock) — never a fresh cash inflow this period, so it can't be
    // summed alongside the gross Recibo figure above.
    const anticiposAplicados = movimientosEnPeriodo
      .filter((r) => r.tipo === 'NA' && r.categoria === 'pago')
      .reduce((sum, r) => sum + (r.abono ?? 0), 0);
    const descuentosAjustes = movimientosEnPeriodo
      .filter((r) => r.categoria === 'descuento')
      .reduce((sum, r) => sum + (r.abono ?? 0), 0);

    // Can go negative — a Recibo received for more than the period's own
    // cargos leaves a credit balance. Not clamped here; rendered as
    // "(A Favor)" at the PDF layer (`estado-cuenta-pdf.ts`) instead.
    const saldoActual =
      saldoAnterior +
      cargosDelMes -
      pagosDelMes -
      anticiposAplicados -
      descuentosAjustes;

    // Step 8b: anticipos pendientes — a live snapshot of this inmueble's own
    // Recibos still carrying a pending balance, same "pending anticipo"
    // definition the Anticipos bandeja uses. Never period-filtered: an
    // anticipo is a CURRENT balance, not a movement that happened during
    // the period being printed, so it stays visible regardless of which
    // period the caller picked. `recibosActivos` (computed above — Step 7
    // reuses the same set) is already scoped to this inmueble, no extra
    // query needed.
    // `unappliedAmount` is no longer a live field on the (now immutable)
    // Recibo — batch-resolved from `SaldoDocumentoOrigen` instead, same
    // live source the JSON detail view reads.
    const saldosOrigenRecibos = recibosActivos.length
      ? await this.saldoDocumentoOrigen
          .find({ documentoId: { $in: recibosActivos.map((r) => r._id) } })
          .exec()
      : [];
    const saldoDisponiblePorRecibo = new Map(
      saldosOrigenRecibos.map((s) => [
        s.documentoId.toString(),
        s.saldoDisponible,
      ]),
    );
    const anticipos = recibosActivos
      .map((r) => ({
        r,
        monto: saldoDisponiblePorRecibo.get(r._id.toString()) ?? 0,
      }))
      .filter(({ monto }) => monto > 0)
      .sort((a, b) => a.r.receivedDate.getTime() - b.r.receivedDate.getTime())
      .map(({ r, monto }) => ({
        numeroCompleto: r.fullNumber,
        fecha: r.receivedDate.toISOString(),
        monto,
      }));

    // Step 9: estado/diasMoraMaximo derivation — "vencida" when ANY of this
    // inmueble's Facturas/Notas Débito still has a positive balance AS OF
    // `hasta` (the statement's OWN cutoff date, `periodEnd`) and had already
    // passed its own vencimiento by that same date — never the real "today"
    // (see `RespuestaEstadoCuenta.estado`'s own docblock), and never just
    // whether the period's own factura had passed its due date, the old
    // (buggy) single-document check. Reuses the same shared point-in-time
    // utility Vencimientos de Cartera/Cartera General rely on for their own
    // historical aging, instead of a bespoke live-balance lookup.
    //
    // `hastaCorte` (shifted +5h, see `finDelDiaCorte`) goes into the query
    // itself — it decides which applications count as already active,
    // including a same-day evening-Colombia payment. `hasta` (raw, pure UTC
    // midnight) is what `calcularDiasMora` compares `fechaReferencia`
    // against — both are always pure UTC-midnight business dates, so
    // comparing them against the SHIFTED cutoff would silently overcount by
    // a day (same bug class `cartera-historica.util.ts` documents at length
    // on `activeAsOf`/`limiteEmisionParaCorte`).
    const hastaCorte = finDelDiaCorte(hasta);
    const documentosConSaldo = await calcularDocumentosConSaldoAFecha(
      {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        saldosIniciales: this.saldosIniciales,
        aplicaciones: this.aplicaciones,
      },
      coPropertyId,
      hastaCorte,
      { inmuebleId },
    );
    let diasMoraMaximo: number | null = null;
    for (const doc of documentosConSaldo) {
      if (doc.fechaReferencia >= hasta) continue;
      const dias = calcularDiasMora(doc.fechaReferencia, hasta);
      if (dias > 0 && (diasMoraMaximo === null || dias > diasMoraMaximo)) {
        diasMoraMaximo = dias;
      }
    }
    const estado: 'al_dia' | 'vencido' =
      diasMoraMaximo !== null ? 'vencido' : 'al_dia';

    // Step 10: build movimientos for API response
    const movimientos: MovimientoEstadoCuenta[] = movimientosEnPeriodo.map(
      (r) => ({
        fecha: r.fecha.toISOString(),
        numeroCompleto: r.numeroCompleto,
        concepto: r.concepto,
        cargo: r.cargo,
        abono: r.abono,
        categoria: r.categoria,
      }),
    );

    return {
      inmuebleCodigo,
      propietario,
      copropiedadTelefono,
      copropiedadEmail,
      periodStart: desde.toISOString(),
      periodEnd: hasta.toISOString(),
      fechaEmision,
      saldoAnterior,
      cargosDelMes,
      pagosDelMes,
      anticiposAplicados,
      descuentosAjustes,
      saldoActual,
      estado,
      diasMoraMaximo,
      movimientos,
      anticipos,
    };
  }
}
