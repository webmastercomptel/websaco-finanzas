import { Types } from 'mongoose';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { SaldoInicialDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import { claveMesDe } from '../../common/contabilidad/periodo.service';
import { formatoFecha } from '../../common/contabilidad/periodo-calendario.util';
import type { MarcasCuentaContable } from '../facturacion/asiento.builder';
import {
  calcularPartesDistribucion,
  calcularPartesWaterfall,
  cuentaCarteraDeLinea,
  evaluarAplicacionConDescuento,
  type DesgloseCarteraAplicacion,
  type ResumenAplicacion,
} from './cruce.util';
import type { NumeroAsignado } from '../../common/numeracion/numeracion.service';
import type { PaymentMethod } from '../../database/schemas/recibos/recibo.schema';
import {
  construirAsientoCruce,
  cuentasOrdenDe,
  enriquecerMovimientosConAuxiliares,
  CUENTA_SIN_ASIGNAR,
} from '../facturacion/asiento.builder';
import { redactarObservaciones } from './recibos.service';
import type { LoteRecibosFila } from '../../database/schemas/recibos/lote-recibos.schema';

/** The inmueble fields this whole module ever reads — deliberately narrow
 *  (never the full `InmuebleDocument`) so the pure functions below stay
 *  decoupled from the schema, same style `cruce.util.ts`'s own
 *  `OrigenAplicacion` uses. */
export interface InmuebleParaAplicacionLote {
  _id: Types.ObjectId;
  holderId: Types.ObjectId | null;
  code: string;
}

/** The coproperty fields this whole module ever reads — a superset of
 *  `asiento.builder.ts`'s own `CopropiedadParaCuentasOrden`, so any value
 *  of this shape is also valid input to `cuentasOrdenDe`. */
export interface CopropiedadParaAplicacionLote {
  receivablesAccount: string | null;
  advancesAccount: string | null;
  discountsDebitAccount: string | null;
  usesMemorandumAccounts: boolean;
  memorandumDebitAccount: string | null;
  memorandumCreditAccount: string | null;
  defaultCostCentre: string | null;
  cashFlowCode: string | null;
  defaultBankAccountCode: string | null;
}

/** One FIFO candidate, already resolved to its real document — kept as a
 *  small discriminated union (not three parallel arrays) so `aplicarFifoEnMemoria`
 *  (Task 4) can walk ONE list in priority order, exactly like `abiertas` in
 *  today's `ejecutarAplicacionFifo`. Priority order is computed ONCE, at
 *  batch-read time (Task 3) — it never changes as balances shrink, only
 *  `saldoPorDocumento` does, so it is safe to reuse across every row of a
 *  tanda that shares this inmueble. */
export type CandidatoAplicacionLote =
  | { tipo: 'FV'; doc: FacturaDocument }
  | { tipo: 'ND'; doc: NotaDebitoDocument }
  | { tipo: 'SI'; doc: SaldoInicialDocument };

/** Everything the batch-lote path knows about ONE inmueble, before any row
 *  against it has been processed. `saldoPorDocumento` is the ONLY mutable
 *  part — `aplicarFifoEnMemoria` (Task 4) decrements it in place as each
 *  row in a tanda consumes balance, so a second row against the same
 *  inmueble in the same tanda sees the first row's own consumption. */
export interface DatosInmuebleParaAplicacionLote {
  inmueble: InmuebleParaAplicacionLote;
  candidatosOrdenados: CandidatoAplicacionLote[];
  /** Keyed by `doc._id.toString()`. */
  saldoPorDocumento: Map<string, number>;
}

/** Everything read ONCE for the whole `aplicar()` call, before any tanda
 *  opens — design §4. */
export interface DatosBatchAplicacionLote {
  /** Keyed by `inmuebleId.toString()`. */
  indicePorInmueble: Map<string, DatosInmuebleParaAplicacionLote>;
  copropiedad: CopropiedadParaAplicacionLote | null;
  cuentasContablesPorCodigo: Map<string, MarcasCuentaContable>;
  /** Keyed by `claveMesDe(fila.fechaPago)` — one entry per DISTINCT month
   *  among the lote's pending rows, not per row. */
  periodoAbiertoPorMes: Map<string, boolean>;
  ultimoLoteFacturacion: { periodStart: Date; periodEnd: Date } | null;
}

export { claveMesDe };

/**
 * Everything `RecibosService.prepararCreacion()` validates per row today,
 * replayed against the pre-fetched batch data instead of live queries —
 * inmueble has a titular, the row's own month is open, the row's date
 * falls inside the current billing period. Mutual-exclusivity/shortfall/
 * surplus checks from `prepararCreacion` are NOT reproduced here: they only
 * ever fire for `dto.aplicaciones`/`dto.destinoSobrante`, and the batch path
 * never sets either (every row is `aplicacionAutomatica: true`, nothing
 * else) — see Task 5's own docblock for the full list of branches this
 * lets the batch path skip.
 *
 * Returns a validation OUTCOME, never throws — `exigirPeriodoFacturacionActual`
 * (the live function this mirrors) throws a `BadRequestException`; inlining
 * the same date comparison as a plain boolean check here (rather than
 * calling that function and catching) keeps this function throw-free like
 * every other pure function in this file, and needs no `try/catch` noise in
 * `procesarFilasTandaAplicacionLote` (Task 6) — a judgment call documented
 * in this plan's own report, since the design didn't specify which way to
 * resolve the throw-vs-boolean mismatch.
 */
export function validarFilaAplicacionLote(
  fila: {
    inmuebleId: Types.ObjectId | null;
    inmuebleCodigo: string;
    fechaPago: Date;
  },
  datos: DatosBatchAplicacionLote,
): { valido: true } | { valido: false; mensaje: string } {
  const datosInmueble = fila.inmuebleId
    ? datos.indicePorInmueble.get(fila.inmuebleId.toString())
    : undefined;
  if (!datosInmueble || !datosInmueble.inmueble.holderId) {
    return {
      valido: false,
      mensaje: `El inmueble ${fila.inmuebleCodigo} ya no tiene titular asignado`,
    };
  }

  const clave = claveMesDe(fila.fechaPago);
  const abierto = datos.periodoAbiertoPorMes.get(clave) ?? true;
  if (!abierto) {
    const [year, month] = clave.split('-');
    return {
      valido: false,
      mensaje:
        `El periodo ${month}/${year} está cerrado. Emitá el documento con ` +
        'fecha de hoy, referenciando el documento original.',
    };
  }

  if (datos.ultimoLoteFacturacion) {
    const { periodStart, periodEnd } = datos.ultimoLoteFacturacion;
    if (fila.fechaPago < periodStart || fila.fechaPago > periodEnd) {
      return {
        valido: false,
        mensaje:
          'La fecha de pago debe estar dentro del período de facturación ' +
          `actual (${formatoFecha(periodStart)} – ${formatoFecha(periodEnd)})`,
      };
    }
  }

  return { valido: true };
}

/** One document this call actually applied money against — plain data, no
 *  Mongo import, no write: `procesarFilasTandaAplicacionLote` (Task 6)
 *  turns this into the real insert/update payloads (Task 5/7). */
export interface AplicacionEnMemoria {
  tipo: 'FV' | 'ND' | 'SI';
  documentId: Types.ObjectId;
  numeroDocumento: number;
  montoAplicado: number;
  discountApplied: number;
  detalleConceptos: {
    conceptoId: Types.ObjectId;
    conceptName: string;
    monto: number;
  }[];
  /** Always negative (a consumption) — the total to `$inc` onto this
   *  document's `SaldoTotalDocumento` row. */
  saldoTotalDocumentoDelta: number;
  /** Always negative per entry — one per concepto this application touched. */
  saldoCarteraDeltas: {
    inmuebleId: Types.ObjectId;
    conceptoId: Types.ObjectId;
    delta: number;
  }[];
  carteraPorDocumentoDeltas: {
    documentoId: Types.ObjectId;
    conceptoId: Types.ObjectId;
    inmuebleId: Types.ObjectId;
    tipoDocumento: 'FV' | 'ND' | 'SI';
    delta: number;
  }[];
}

export interface ResultadoFifoEnMemoria {
  aplicaciones: AplicacionEnMemoria[];
  desglose: DesgloseCarteraAplicacion[];
  montoAplicadoMora: number;
  montoDescuentoTotal: number;
  resumen: ResumenAplicacion[];
  montoSinAplicar: number;
}

/**
 * Reproduces `ejecutarAplicacionFifo`'s exact walk (`cruce.util.ts`) against
 * `datosInmueble.candidatosOrdenados` — same priority order, same
 * discount/mora rules, same waterfall/distribución split (via
 * `calcularPartesWaterfall`/`calcularPartesDistribucion`, Task 1) — but
 * reading/writing `datosInmueble.saldoPorDocumento` in place instead of
 * `SaldoTotalDocumento` in Mongo. No `AplicacionInvalidaError`/`errores[]`:
 * the only reason that DB version can find a candidate already exhausted
 * is a genuinely concurrent writer, which cannot happen against this
 * in-memory map within one tanda — a candidate at `saldoPendiente <= 0` is
 * simply skipped (an earlier row in this same tanda already finished it
 * off), never an error.
 */
export function aplicarFifoEnMemoria(
  datosInmueble: DatosInmuebleParaAplicacionLote,
  montoDisponible: number,
  fechaRecibo: Date,
  usesMemorandumAccounts: boolean,
): ResultadoFifoEnMemoria {
  const aplicaciones: AplicacionEnMemoria[] = [];
  const desglose: DesgloseCarteraAplicacion[] = [];
  let restante = montoDisponible;
  let montoAplicadoMora = 0;
  let montoDescuentoTotal = 0;
  const resumen: ResumenAplicacion[] = [];

  for (const candidato of datosInmueble.candidatosOrdenados) {
    if (restante <= 0) break;
    const documentoId = candidato.doc._id;
    const clave = documentoId.toString();
    const saldoPendiente = datosInmueble.saldoPorDocumento.get(clave) ?? 0;
    if (saldoPendiente <= 0) continue;

    if (candidato.tipo === 'ND') {
      const nota = candidato.doc;
      const monto = Math.min(restante, saldoPendiente);
      const saldoPendienteDespues = saldoPendiente - monto;
      datosInmueble.saldoPorDocumento.set(clave, saldoPendienteDespues);

      const partes = calcularPartesDistribucion(
        [{ conceptoId: nota.conceptoId, monto: nota.total }],
        monto,
      );
      desglose.push({
        cuenta: null,
        monto,
        tipoDocumento: 'ND',
        numeroDocumento: nota.number,
      });
      aplicaciones.push({
        tipo: 'ND',
        documentId: documentoId,
        numeroDocumento: nota.number,
        montoAplicado: monto,
        discountApplied: 0,
        detalleConceptos: [
          {
            conceptoId: nota.conceptoId,
            conceptName: nota.description ?? 'Nota Débito',
            monto,
          },
        ],
        saldoTotalDocumentoDelta: -monto,
        saldoCarteraDeltas: partes.map((p) => ({
          inmuebleId: nota.inmuebleId,
          conceptoId: p.conceptoId,
          delta: -p.parte,
        })),
        carteraPorDocumentoDeltas: partes.map((p) => ({
          documentoId,
          conceptoId: p.conceptoId,
          inmuebleId: nota.inmuebleId,
          tipoDocumento: 'ND',
          delta: -p.parte,
        })),
      });
      resumen.push({
        tipo: 'ND',
        numero: nota.number,
        completa: saldoPendienteDespues === 0,
      });
      restante -= monto;
      continue;
    }

    if (candidato.tipo === 'FV') {
      const factura = candidato.doc;
      const { montoAFactura: montoSinCapar, montoDescuento } =
        evaluarAplicacionConDescuento(
          {
            outstandingBalance: saldoPendiente,
            discountAmount: factura.discountAmount,
            discountDeadline: factura.discountDeadline,
          },
          fechaRecibo,
          restante,
        );
      const monto = Math.min(montoSinCapar, saldoPendiente);
      const cashUsado = monto - montoDescuento;
      const saldoPendienteDespues = saldoPendiente - monto;
      datosInmueble.saldoPorDocumento.set(clave, saldoPendienteDespues);

      const lines = factura.lines.map((l) => ({
        conceptoId: l.conceptoId,
        totalAmount: l.totalAmount,
      }));
      const partes = calcularPartesWaterfall(
        {
          total: factura.total,
          outstandingBalance: saldoPendienteDespues,
          lines,
        },
        monto,
        -1,
      );
      const detalleConceptos = partes.map((p) => {
        const linea = factura.lines.find((l) =>
          l.conceptoId.equals(p.conceptoId),
        );
        return {
          conceptoId: p.conceptoId,
          conceptName: linea?.conceptName ?? 'Concepto',
          monto: p.parte,
        };
      });
      for (const p of partes) {
        const linea = factura.lines.find((l) =>
          l.conceptoId.equals(p.conceptoId),
        );
        if (p.parte !== 0) {
          desglose.push({
            cuenta: cuentaCarteraDeLinea(linea, usesMemorandumAccounts),
            monto: p.parte,
            tipoDocumento: 'FV',
            numeroDocumento: factura.number,
          });
        }
        if (linea?.conceptKind === 'intereses') {
          montoAplicadoMora += p.parte;
        }
      }
      aplicaciones.push({
        tipo: 'FV',
        documentId: documentoId,
        numeroDocumento: factura.number,
        montoAplicado: monto,
        discountApplied: montoDescuento,
        detalleConceptos,
        saldoTotalDocumentoDelta: -monto,
        saldoCarteraDeltas: partes.map((p) => ({
          inmuebleId: factura.inmuebleId,
          conceptoId: p.conceptoId,
          delta: -p.parte,
        })),
        carteraPorDocumentoDeltas: partes.map((p) => ({
          documentoId,
          conceptoId: p.conceptoId,
          inmuebleId: factura.inmuebleId,
          tipoDocumento: 'FV',
          delta: -p.parte,
        })),
      });
      resumen.push({
        tipo: 'FV',
        numero: factura.number,
        completa: saldoPendienteDespues === 0,
      });
      montoDescuentoTotal += montoDescuento;
      restante -= cashUsado;
      continue;
    }

    // 'SI' — Saldo Inicial: same waterfall as FV, never a discount (a
    // Saldo Inicial never carries `discountAmount`/`discountDeadline`).
    const saldoInicial = candidato.doc;
    const monto = Math.min(restante, saldoPendiente);
    const saldoPendienteDespues = saldoPendiente - monto;
    datosInmueble.saldoPorDocumento.set(clave, saldoPendienteDespues);

    const lines = saldoInicial.lines.map((l) => ({
      conceptoId: l.conceptoId,
      totalAmount: l.montoOriginal,
    }));
    const partes = calcularPartesWaterfall(
      {
        total: saldoInicial.total,
        outstandingBalance: saldoPendienteDespues,
        lines,
      },
      monto,
      -1,
    );
    const detalleConceptos = partes.map((p) => {
      const linea = saldoInicial.lines.find((l) =>
        l.conceptoId.equals(p.conceptoId),
      );
      return {
        conceptoId: p.conceptoId,
        conceptName: linea?.conceptName ?? 'Concepto',
        monto: p.parte,
      };
    });
    for (const p of partes) {
      const linea = saldoInicial.lines.find((l) =>
        l.conceptoId.equals(p.conceptoId),
      );
      if (p.parte !== 0) {
        desglose.push({
          cuenta: cuentaCarteraDeLinea(linea, usesMemorandumAccounts),
          monto: p.parte,
          tipoDocumento: 'SI',
          numeroDocumento: saldoInicial.number,
        });
      }
      if (linea?.conceptKind === 'intereses') {
        montoAplicadoMora += p.parte;
      }
    }
    aplicaciones.push({
      tipo: 'SI',
      documentId: documentoId,
      numeroDocumento: saldoInicial.number,
      montoAplicado: monto,
      discountApplied: 0,
      detalleConceptos,
      saldoTotalDocumentoDelta: -monto,
      saldoCarteraDeltas: partes.map((p) => ({
        inmuebleId: saldoInicial.inmuebleId,
        conceptoId: p.conceptoId,
        delta: -p.parte,
      })),
      carteraPorDocumentoDeltas: partes.map((p) => ({
        documentoId,
        conceptoId: p.conceptoId,
        inmuebleId: saldoInicial.inmuebleId,
        tipoDocumento: 'SI',
        delta: -p.parte,
      })),
    });
    resumen.push({
      tipo: 'SI',
      numero: saldoInicial.number,
      completa: saldoPendienteDespues === 0,
    });
    restante -= monto;
  }

  return {
    aplicaciones,
    desglose,
    montoAplicadoMora,
    montoDescuentoTotal,
    resumen,
    montoSinAplicar: restante,
  };
}

export interface EscrituraFilaAplicacionLote {
  reciboId: Types.ObjectId;
  recibo: Record<string, unknown>;
  saldoDocumentoOrigen: Record<string, unknown>;
  aplicacionesCartera: Record<string, unknown>[];
  asientoContable: Record<string, unknown>;
  saldoTotalDocumentoDeltas: { documentoId: Types.ObjectId; delta: number }[];
  saldoCarteraDeltas: {
    inmuebleId: Types.ObjectId;
    conceptoId: Types.ObjectId;
    delta: number;
  }[];
  carteraPorDocumentoDeltas: {
    documentoId: Types.ObjectId;
    conceptoId: Types.ObjectId;
    inmuebleId: Types.ObjectId;
    tipoDocumento: 'FV' | 'ND' | 'SI';
    delta: number;
  }[];
}

/**
 * Builds every insert/delta this row's Recibo needs, purely from
 * `resultadoFifo` (Task 4) — no DB, no session. Skips every branch
 * `crearEnSesion` only runs for manual/`destinoSobrante` mode — see this
 * task's own docblock above for the full list — so `notes` is computed
 * up front and baked directly into the Recibo insert document, and the
 * post-creation `findOneAndUpdate` `crearEnSesion` needs disappears
 * entirely for this path.
 */
export function construirEscrituraFilaAplicacion(ctx: {
  coPropertyId: Types.ObjectId;
  accountId: string;
  fila: { valorRecibido: number; fechaPago: Date };
  numero: NumeroAsignado;
  medioPago: PaymentMethod;
  destinationAccount: string;
  datosInmueble: DatosInmuebleParaAplicacionLote;
  copropiedad: CopropiedadParaAplicacionLote | null;
  cuentasContablesPorCodigo: Map<string, MarcasCuentaContable>;
  resultadoFifo: ResultadoFifoEnMemoria;
}): EscrituraFilaAplicacionLote {
  const reciboId = new Types.ObjectId();
  const totalAplicado = ctx.resultadoFifo.aplicaciones.reduce(
    (acc, a) => acc + a.montoAplicado,
    0,
  );
  const cashAplicado = totalAplicado - ctx.resultadoFifo.montoDescuentoTotal;
  const sobrante = ctx.fila.valorRecibido - cashAplicado;
  const notes =
    redactarObservaciones(ctx.resultadoFifo.resumen, sobrante > 0) || null;

  const cuentaCartera =
    ctx.copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentaAnticipos =
    ctx.copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentaDescuentos =
    ctx.copropiedad?.discountsDebitAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentasOrden = cuentasOrdenDe(ctx.copropiedad);
  const desgloseCartera = ctx.resultadoFifo.desglose.map((d) => ({
    account: d.cuenta ?? cuentaCartera,
    monto: d.monto,
    tipoDocumento: d.tipoDocumento,
    numeroDocumento: d.numeroDocumento,
  }));

  let entries = construirAsientoCruce(
    ctx.destinationAccount,
    cuentaCartera,
    cuentaAnticipos,
    totalAplicado,
    sobrante,
    'RC',
    cuentasOrden,
    desgloseCartera,
    ctx.resultadoFifo.montoAplicadoMora,
    ctx.resultadoFifo.montoDescuentoTotal > 0
      ? {
          cuenta: cuentaDescuentos,
          monto: ctx.resultadoFifo.montoDescuentoTotal,
        }
      : undefined,
  );
  entries = enriquecerMovimientosConAuxiliares(
    entries,
    ctx.cuentasContablesPorCodigo,
    {
      terceroCode: ctx.datosInmueble.inmueble.code,
      centroCosto: ctx.copropiedad?.defaultCostCentre ?? null,
      flujoCajaCodigo: ctx.copropiedad?.cashFlowCode ?? null,
    },
  );

  return {
    reciboId,
    recibo: {
      _id: reciboId,
      coPropertyId: ctx.coPropertyId,
      inmuebleId: ctx.datosInmueble.inmueble._id,
      terceroId: ctx.datosInmueble.inmueble.holderId,
      prefix: ctx.numero.prefijo,
      number: ctx.numero.numero,
      fullNumber: ctx.numero.completo,
      receivedAmount: ctx.fila.valorRecibido,
      receivedDate: ctx.fila.fechaPago,
      paymentMethod: ctx.medioPago,
      destinationAccount: ctx.destinationAccount,
      reference: null,
      notes,
      appliedAmount: 0,
      unappliedAmount: ctx.fila.valorRecibido,
      status: 'activo',
      generatedBy: ctx.accountId,
      otherIncomeAmount: 0,
    },
    saldoDocumentoOrigen: {
      coPropertyId: ctx.coPropertyId,
      tipoDocumento: 'RC',
      documentoId: reciboId,
      montoOriginal: ctx.fila.valorRecibido,
      saldoDisponible: sobrante,
    },
    aplicacionesCartera: ctx.resultadoFifo.aplicaciones.map((a) => ({
      coPropertyId: ctx.coPropertyId,
      sourceType: 'RC',
      sourceId: reciboId,
      documentType: a.tipo,
      documentId: a.documentId,
      amountApplied: a.montoAplicado,
      discountApplied: a.discountApplied,
      detalleConceptos: a.detalleConceptos,
      status: 'activa',
      appliedAt: new Date(),
      sourceDate: ctx.fila.fechaPago,
      appliedBy: ctx.accountId,
    })),
    asientoContable: {
      coPropertyId: ctx.coPropertyId,
      loteId: null,
      facturaId: null,
      reciboId,
      date: ctx.fila.fechaPago,
      entries,
    },
    saldoTotalDocumentoDeltas: ctx.resultadoFifo.aplicaciones.map((a) => ({
      documentoId: a.documentId,
      delta: a.saldoTotalDocumentoDelta,
    })),
    saldoCarteraDeltas: ctx.resultadoFifo.aplicaciones.flatMap(
      (a) => a.saldoCarteraDeltas,
    ),
    carteraPorDocumentoDeltas: ctx.resultadoFifo.aplicaciones.flatMap(
      (a) => a.carteraPorDocumentoDeltas,
    ),
  };
}

export type ResultadoTandaAplicacionLote =
  | {
      ok: true;
      escrituras: EscrituraFilaAplicacionLote[];
      /** The per-inmueble `saldoPorDocumento` state AFTER this tanda's FIFO
       *  math, for every inmueble this tanda actually touched — the
       *  caller (`LoteRecibosService.procesarTanda`) merges this into the
       *  shared `DatosBatchAplicacionLote` ONLY once this tanda's write
       *  transaction actually commits (final review, Important finding
       *  C2: a failed tanda must never leak its in-memory consumption
       *  into the state a LATER tanda reads). */
      indiceActualizado: Map<string, DatosInmuebleParaAplicacionLote>;
    }
  | { ok: false; erroresPorIndice: Map<number, string> };

/** Same collateral-message shape `LoteRecibosService.procesarTanda`'s own
 *  catch block produces today (`lote-recibos.service.ts:519-536`) — the
 *  culprit row keeps its own message, every other row in the tanda gets
 *  attributed to it. `indiceCulpable`/every `indice` here are the SAME
 *  0-based index into `lote.filas` `ejecutarAplicacion` already threads
 *  through `pendientesConNumero`. */
function construirErrorTanda(
  filas: { indice: number }[],
  indiceCulpable: number,
  mensajeCulpable: string,
): ResultadoTandaAplicacionLote {
  const erroresPorIndice = new Map<number, string>();
  for (const { indice } of filas) {
    erroresPorIndice.set(
      indice,
      indice === indiceCulpable
        ? mensajeCulpable
        : `Revertida junto con la fila ${indiceCulpable + 1}, que falló: ${mensajeCulpable}`,
    );
  }
  return { ok: false, erroresPorIndice };
}

/**
 * Runs Tasks 2/4/5 per row of ONE tanda, sequentially and in order, against
 * a TANDA-LOCAL clone of the touched inmuebles' `saldoPorDocumento` maps —
 * never the shared `datos.indicePorInmueble` directly (final review,
 * Important finding C2). The clone is what lets a later row in the SAME
 * tanda see an earlier row's own consumption (design §4 step 6); cloning
 * it, instead of mutating the shared entry in place, is what lets a
 * FAILED tanda's partial consumption disappear along with it — the shared
 * state only ever advances via the `indiceActualizado` this function
 * returns on success, which the caller merges in ONLY after this tanda's
 * write transaction actually commits. The FIRST invalid row stops the
 * loop immediately: nothing after it is even evaluated, mirroring the
 * "whole tanda goes down together" semantics `procesarTanda`'s
 * transaction gives today, just decided here instead of via rollback.
 */
export function procesarFilasTandaAplicacionLote(
  filas: { fila: LoteRecibosFila; indice: number; numero: NumeroAsignado }[],
  datos: DatosBatchAplicacionLote,
  ctx: {
    coPropertyId: Types.ObjectId;
    accountId: string;
    medioPago: PaymentMethod;
    destinationAccount: string;
  },
): ResultadoTandaAplicacionLote {
  const escrituras: EscrituraFilaAplicacionLote[] = [];
  // Cloned lazily, per inmueble, the first time this tanda touches it —
  // `inmueble`/`candidatosOrdenados` are read-only for the whole run and
  // shared by reference; only `saldoPorDocumento` (the mutable part) gets
  // its own `Map` copy, so mutating it here never reaches the original.
  const indiceLocal = new Map<string, DatosInmuebleParaAplicacionLote>();
  const datosInmuebleLocal = (
    clave: string,
  ): DatosInmuebleParaAplicacionLote => {
    const existente = indiceLocal.get(clave);
    if (existente) return existente;
    const original = datos.indicePorInmueble.get(clave)!;
    const copia: DatosInmuebleParaAplicacionLote = {
      inmueble: original.inmueble,
      candidatosOrdenados: original.candidatosOrdenados,
      saldoPorDocumento: new Map(original.saldoPorDocumento),
    };
    indiceLocal.set(clave, copia);
    return copia;
  };

  for (const { fila, indice, numero } of filas) {
    const validacion = validarFilaAplicacionLote(fila, datos);
    if (!validacion.valido) {
      return construirErrorTanda(filas, indice, validacion.mensaje);
    }

    const datosInmueble = datosInmuebleLocal(fila.inmuebleId!.toString());
    const resultadoFifo = aplicarFifoEnMemoria(
      datosInmueble,
      fila.valorRecibido,
      fila.fechaPago,
      datos.copropiedad?.usesMemorandumAccounts ?? false,
    );
    const escritura = construirEscrituraFilaAplicacion({
      coPropertyId: ctx.coPropertyId,
      accountId: ctx.accountId,
      fila,
      numero,
      medioPago: ctx.medioPago,
      destinationAccount: ctx.destinationAccount,
      datosInmueble,
      copropiedad: datos.copropiedad,
      cuentasContablesPorCodigo: datos.cuentasContablesPorCodigo,
      resultadoFifo,
    });
    escrituras.push(escritura);
  }

  return { ok: true, escrituras, indiceActualizado: indiceLocal };
}
