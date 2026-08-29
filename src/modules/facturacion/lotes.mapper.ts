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
 * two meet — see "the contract law" in AGENTS.md, same pattern as
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
  diasGraciaDescuento: doc.discountGraceDays,
  interesMora: doc.lateInterestRate,
  topeInteresMora: doc.lateInterestCap,
  totalNovedades: doc.adjustments.length,
  totalPrevisualizacion: doc.preview.length,
  resumen: doc.summary
    ? {
        montoTotal: doc.summary.totalAmount,
        totalFacturas: doc.summary.totalInvoices,
        totalInmuebles: doc.summary.totalUnits,
      }
    : null,
});

const preliminarDe = (p: FacturaPreliminar): FacturaPreliminarContract => ({
  inmuebleId: p.inmuebleId.toString(),
  inmuebleCodigo: p.unitCode,
  terceroId: p.terceroId ? p.terceroId.toString() : null,
  titular: titularDe(p.holder),
  lineas: p.lines.map(lineaDe),
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
