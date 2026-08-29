import type { LoteFacturacion as LoteContract } from '../../contracts';
import type { LoteFacturacionDocument } from '../../database/schemas/facturacion/lote-facturacion.schema';

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
