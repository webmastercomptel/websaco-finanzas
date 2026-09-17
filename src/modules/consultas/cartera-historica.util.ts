import { Model, Types } from 'mongoose';
import { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import { SaldoInicialDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';

/**
 * Turns a bare "fecha de corte" (a calendar day picked by the user, or
 * `query.fecha` parsed as that day's UTC midnight) into the actual instant
 * that day ends for this product's users — all of them in Colombia
 * (UTC-5), never the server's own timezone (Cloud Run runs UTC).
 *
 * 23:59:59.999 local in Bogotá is 04:59:59.999 UTC the FOLLOWING calendar
 * day — `setUTCHours(28, ...)` rolls over on purpose. Without this, a
 * Recibo applied this evening in Colombia (which lands after UTC midnight,
 * so "tomorrow" in raw UTC) reads as `appliedAt > fecha` in `activeAsOf`
 * and silently drops out of every point-in-time report for the rest of
 * the same local day — the exact bug reported for Cartera por Inmueble.
 */
export function finDelDiaCorte(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(23 + 5, 59, 59, 999);
  return r;
}

/** The UTC-5 reach `finDelDiaCorte` adds past the queried day's own
 *  midnight — see `activeAsOf`'s own comment on why this needs to be
 *  subtracted back out before comparing a pure calendar date like
 *  `sourceDate` against a `finDelDiaCorte`-shifted cutoff. */
const CORRIMIENTO_FIN_DIA_MS = 5 * 60 * 60 * 1000;

/** True when `fecha` carries `finDelDiaCorte`'s own fixed signature
 *  (always exactly 04:59:59.999 UTC, from its `setUTCHours(28, …)`
 *  rollover) — used to tell a shifted historical cutoff apart from a plain
 *  real-time instant (`new Date()`), which needs no such adjustment. */
function esFechaDeCorte(fecha: Date): boolean {
  return (
    fecha.getUTCHours() === 4 &&
    fecha.getUTCMinutes() === 59 &&
    fecha.getUTCSeconds() === 59 &&
    fecha.getUTCMilliseconds() === 999
  );
}

/**
 * The upper bound for filtering `issueDate` — a Factura/NotaDebito's own
 * PURE calendar date, always UTC midnight, never a real time-of-day —
 * against a "fecha de corte" cutoff. When `fecha` carries `finDelDiaCorte`'s
 * own shifted signature (reaching up to 5h into the next UTC day, to
 * correctly bound a REAL Colombia-evening timestamp like `appliedAt`), that
 * reach must be undone before comparing against a field that never has a
 * real time-of-day — otherwise a document issued at UTC midnight the NEXT
 * calendar day (e.g. billed July 1st, `issueDate`
 * "2026-07-01T00:00:00.000Z") falls inside that reach
 * ("2026-07-01T04:59:59.999Z") and is wrongly included in a query cut off
 * at June 30 — the exact bug reported: a Factura from the next billing run
 * showing up in a "fecha de corte"/"período" report scoped to the prior
 * month. Same reasoning/fix as `activeAsOf`'s own `sourceDate` un-shift,
 * applied here to the `issueDate` filter bound instead. A real "now" instant
 * (the "vigente" case, never `finDelDiaCorte`-shifted) passes through
 * unchanged, since it never matches the signature.
 */
export function limiteEmisionParaCorte(fecha: Date): Date {
  return esFechaDeCorte(fecha)
    ? new Date(fecha.getTime() - CORRIMIENTO_FIN_DIA_MS)
    : fecha;
}

/**
 * A document (Factura or NotaDebito) with a positive outstanding balance
 * as of a historical date. Returned by `calcularDocumentosConSaldoAFecha`.
 */
export interface DocumentoConSaldoAFecha {
  inmuebleId: Types.ObjectId;
  tipo: 'FV' | 'ND' | 'SI';
  montoPendiente: number;
  fechaReferencia: Date;
}

/**
 * Determine whether an application was active as of a given date.
 *
 * An application is "active as of `fecha`" if it was effective at or before
 * `fecha` AND either:
 *  - it is still active (`status === 'activa'`), OR
 *  - it was reverted AFTER `fecha` (`status === 'revertida'` AND
 *    `revertedAt > fecha`)
 *
 * The second condition means: at `fecha` the application had already reduced
 * the balance but its reversal had not yet happened.
 *
 * "Effective at or before `fecha`" is judged by `sourceDate` — the SOURCE
 * document's own declared business date (`Recibo.receivedDate`, etc.) — not
 * `appliedAt` (the system-entry timestamp). A Recibo dated June but entered
 * late in July genuinely reduced the balance as of June, from the
 * accounting period's point of view; keying off `appliedAt` instead made
 * `calcularDocumentosConSaldoAFecha`'s `saldoAnterior` miss it for exactly
 * one period (a real drift reported for the July Conciliación de Cartera).
 * `?? app.appliedAt` is a fallback for a row that predates this field, or a
 * test fixture that hasn't set it — never for a row created going forward,
 * every write site now populates `sourceDate`. `revertedAt` stays
 * system-time on purpose (see its own schema docblock).
 *
 * `sourceDate` is always a PURE calendar date — UTC midnight of whatever day
 * was declared, never a real time-of-day. Comparing it directly against a
 * `finDelDiaCorte`-shifted `fecha` (which deliberately reaches 5h into the
 * NEXT UTC day, to correctly bound a real evening-Colombia timestamp like
 * `appliedAt`/`revertedAt`) double-counts that reach: a document dated the
 * very next calendar day has its own midnight UTC fall inside that 5h
 * window, so it read as already active a full day early (a real bug
 * reported: a Factura from Jun 1, paid by a Recibo dated Jun 12, showed as
 * already settled when querying Cartera por Inmueble as of Jun 11). Un-shift
 * the cutoff by that same 5h before comparing `sourceDate` specifically —
 * `appliedAt`/`revertedAt` keep the cutoff as `finDelDiaCorte` built it.
 */
export function activeAsOf(
  app: {
    status: string;
    appliedAt: Date;
    sourceDate?: Date;
    revertedAt: Date | null;
  },
  fecha: Date,
): boolean {
  const efectiva = app.sourceDate ?? app.appliedAt;
  const fechaComparacion =
    app.sourceDate && esFechaDeCorte(fecha)
      ? new Date(fecha.getTime() - CORRIMIENTO_FIN_DIA_MS)
      : fecha;
  if (efectiva > fechaComparacion) return false;
  if (app.status === 'activa') return true;
  if (app.status === 'revertida' && app.revertedAt && app.revertedAt > fecha)
    return true;
  return false;
}

/**
 * Compute the outstanding balance of a document as of `fecha` given a list
 * of its applications.
 *
 * saldoAtCorte = total − sum(amountApplied of every application that was
 *                active as of `fecha`)
 */
function saldoDocumentoAFecha(
  total: number,
  apps: Array<{
    amountApplied: number;
    appliedAt: Date;
    sourceDate?: Date;
    status: string;
    revertedAt: Date | null;
  }>,
  fecha: Date,
): number {
  let activeAtFecha = 0;
  for (const app of apps) {
    if (activeAsOf(app, fecha)) {
      activeAtFecha += app.amountApplied;
    }
  }
  return Math.max(0, total - activeAtFecha);
}

/**
 * Shared point-in-time utility: returns every Factura and NotaDebito with a
 * positive outstanding balance as of `fecha`, coproperty-wide (or scoped
 * by `opciones`).
 *
 * Used by:
 *  - Vencimientos de Cartera (§8 addendum) for historical aging
 *  - Cartera General (§2) for aggregate KPIs
 *
 * The utility is a pure function taking model references — the same
 * "inject models, return data" shape as `cruce.util.ts`.
 */
export async function calcularDocumentosConSaldoAFecha(
  models: {
    facturas: Model<FacturaDocument>;
    notasDebito: Model<NotaDebitoDocument>;
    saldosIniciales?: Model<SaldoInicialDocument>;
    aplicaciones: Model<AplicacionCarteraDocument>;
  },
  coPropertyId: Types.ObjectId,
  fecha: Date,
  opciones?: { inmuebleId?: Types.ObjectId; conceptoId?: Types.ObjectId },
): Promise<DocumentoConSaldoAFecha[]> {
  const limiteEmision = limiteEmisionParaCorte(fecha);
  const facturasFilter: Record<string, unknown> = {
    coPropertyId,
    status: 'emitida',
    issueDate: { $lte: limiteEmision },
  };
  const ndFilter: Record<string, unknown> = {
    coPropertyId,
    status: 'emitida',
    issueDate: { $lte: limiteEmision },
  };
  // A Saldo Inicial's own `fecha` is its equivalent of `issueDate` — always
  // in the past relative to any real period this coproperty runs in this
  // system (see `SaldoInicial`'s own schema docblock), but filtered the same
  // way for consistency and to correctly exclude one from a cutoff BEFORE
  // its own declared date.
  const siFilter: Record<string, unknown> = {
    coPropertyId,
    status: 'activo',
    fecha: { $lte: limiteEmision },
  };

  if (opciones?.inmuebleId) {
    facturasFilter.inmuebleId = opciones.inmuebleId;
    ndFilter.inmuebleId = opciones.inmuebleId;
    siFilter.inmuebleId = opciones.inmuebleId;
  }
  if (opciones?.conceptoId) {
    facturasFilter['lines.conceptoId'] = opciones.conceptoId;
    ndFilter.conceptoId = opciones.conceptoId;
    siFilter['lines.conceptoId'] = opciones.conceptoId;
  }

  const [facturas, notasDebito, saldosIniciales] = await Promise.all([
    models.facturas.find(facturasFilter).exec(),
    models.notasDebito.find(ndFilter).exec(),
    models.saldosIniciales
      ? models.saldosIniciales.find(siFilter).exec()
      : Promise.resolve([]),
  ]);

  // Collect document IDs to find their applications
  const facturaIds = facturas.map((f) => f._id);
  const ndIds = notasDebito.map((nd) => nd._id);
  const siIds = saldosIniciales.map((s) => s._id);
  const docIds = [...facturaIds, ...ndIds, ...siIds];

  const aplicaciones = docIds.length
    ? await models.aplicaciones
        .find({ coPropertyId, documentId: { $in: docIds } })
        .exec()
    : [];

  // Index applications by documentId
  const appsByDoc = new Map<string, typeof aplicaciones>();
  for (const app of aplicaciones) {
    const key = app.documentId.toString();
    const list = appsByDoc.get(key) ?? [];
    list.push(app);
    appsByDoc.set(key, list);
  }

  const resultado: DocumentoConSaldoAFecha[] = [];

  for (const f of facturas) {
    const docApps = appsByDoc.get(f._id.toString()) ?? [];
    const monto = saldoDocumentoAFecha(f.total, docApps, fecha);
    if (monto > 0) {
      resultado.push({
        inmuebleId: f.inmuebleId,
        tipo: 'FV',
        montoPendiente: monto,
        fechaReferencia: f.dueDate,
      });
    }
  }

  for (const nd of notasDebito) {
    const docApps = appsByDoc.get(nd._id.toString()) ?? [];
    const monto = saldoDocumentoAFecha(nd.total, docApps, fecha);
    if (monto > 0) {
      resultado.push({
        inmuebleId: nd.inmuebleId,
        tipo: 'ND',
        montoPendiente: monto,
        fechaReferencia: nd.issueDate,
      });
    }
  }

  for (const si of saldosIniciales) {
    const docApps = appsByDoc.get(si._id.toString()) ?? [];
    const monto = saldoDocumentoAFecha(si.total, docApps, fecha);
    if (monto > 0) {
      resultado.push({
        inmuebleId: si.inmuebleId,
        tipo: 'SI',
        montoPendiente: monto,
        fechaReferencia: si.fechaVencimiento,
      });
    }
  }

  return resultado;
}
