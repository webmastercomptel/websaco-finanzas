import {
  generarContextoDocumentoFacturacion,
  calcularDescuentoProntoPago,
} from './factura-pdf';
import type { FacturaPreliminar } from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { LoteFacturacionDocument } from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Generates a preview PDF for one unit's not-yet-issued FacturaPreliminar.
 * Same layout as `generarPdfFactura` — per product decision, a prefactura
 * and a factura must look identical — built through the same shared
 * renderer; the only visible difference is the "PREFACTURA" title in place
 * of the document's real name. Dates come from the parent Lote — a
 * preliminar itself carries none — and there is no DIAN footer or
 * duplicado stamp, since nothing has been issued yet to authorise or
 * duplicate.
 */
export async function generarPdfPrefactura(
  preliminar: FacturaPreliminar,
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const descuento = calcularDescuentoProntoPago(
    preliminar.lines,
    lote.earlyPaymentDiscount,
    lote.discountDeadline,
  );
  const ctx = await generarContextoDocumentoFacturacion(
    {
      titulo: 'PREFACTURA',
      unitCode: preliminar.unitCode,
      holder: preliminar.holder,
      issueDate: lote.billingDate,
      dueDate: lote.dueDate,
      periodStart: lote.periodStart,
      periodEnd: lote.periodEnd,
      lines: preliminar.lines,
      descuento,
    },
    copropiedad,
  );

  return ctx.doc.save();
}
