import type {
  LoteFacturacion as LoteContract,
  LoteFacturacionDetalle,
  FacturaPreliminar as FacturaPreliminarContract,
} from '../../contracts';
import type { LoteFacturacionDocument } from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { FacturaPreliminar } from '../../database/schemas/facturacion/lote-facturacion.schema';
import { titularDe, lineaDe } from './facturas.mapper';

/**
 * Maps a billing-run document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md, same pattern as
 * `toFactura`.
 */
export const toLote = (doc: LoteFacturacionDocument): LoteContract => ({
  id: doc._id.toString(),
  numero: doc.number,
  estado: doc.status,
  fechaFacturacion: doc.billingDate.toISOString(),
  fechaVencimiento: doc.dueDate.toISOString(),
  periodoDesde: doc.periodStart.toISOString(),
  periodoHasta: doc.periodEnd.toISOString(),
  descuentoProntoPago: doc.earlyPaymentDiscount,
  valorFijoDescuentoProntoPago: doc.earlyPaymentDiscountFixedValue,
  diasGraciaDescuento: doc.discountGraceDays,
  interesMora: doc.lateInterestRate,
  topeInteresMora: doc.lateInterestCap,
  // `discountDeadline`/`serviceSuspensionDate` have no schema `default` (only
  // `required: true`, which Mongoose enforces on save, never on read) — a
  // lote created before these two fields existed reads back with them
  // `undefined`, and `.toISOString()` on that would 500 the WHOLE list, not
  // just this one row. Falls back to the same defaults `crear()` computes
  // when the caller omits them, so an old lote still shows something sane.
  fechaLimiteDescuento: (doc.discountDeadline ?? doc.billingDate).toISOString(),
  fechaSuspension: (doc.serviceSuspensionDate ?? doc.periodEnd).toISOString(),
  totalNovedades: doc.adjustments.length,
  totalPrevisualizacion: doc.preview.length,
  resumen: doc.summary
    ? {
        montoTotal: doc.summary.totalAmount,
        totalFacturas: doc.summary.totalInvoices,
        totalInmuebles: doc.summary.totalUnits,
      }
    : null,
  progreso: doc.progress
    ? { actual: doc.progress.current, total: doc.progress.total }
    : null,
});

const preliminarDe = (p: FacturaPreliminar): FacturaPreliminarContract => ({
  inmuebleId: p.inmuebleId.toString(),
  inmuebleCodigo: p.unitCode,
  terceroId: p.terceroId ? p.terceroId.toString() : null,
  titular: titularDe(p.holder),
  // Nothing has been issued yet — every línea's own total is entirely
  // pending. NOT `p.lines.map(lineaDe)`: `.map` would silently pass the
  // array INDEX as `lineaDe`'s second (`saldoPendiente`) argument instead.
  lineas: p.lines.map((linea) => lineaDe(linea, linea.totalAmount)),
  subtotal: p.subtotal,
  totalImpuestos: p.totalTax,
  total: p.total,
});

/**
 * `toLote` plus the full previsualización array — what `findOne()` returns
 * so the Liquidación screen can render its table. `findAll()` keeps using
 * `toLote` — the listing must not embed every lote's full preview array.
 */
export const toLoteDetalle = (
  doc: LoteFacturacionDocument,
): LoteFacturacionDetalle => ({
  ...toLote(doc),
  previsualizacion: doc.preview.map(preliminarDe),
});
