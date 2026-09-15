import type { ReactElement } from 'react';
import { reporteDocumento, renderizarPdf } from './react/document';
import { contenidoDocumentoFacturacion } from './factura-pdf.react';
import { calcularDescuentoProntoPago } from '../facturacion/descuento-pronto-pago.util';
import type { DatosDocumentoFacturacion } from './factura-pdf';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * One Preliminar's page content — factored out so
 * `prefacturas-lote-pdf.react.ts` can reuse it across N pages of one
 * `<Document>` instead of merging N independently rendered PDFs (see
 * `paginaFactura`'s docblock for why).
 */
export function paginaPrefactura(
  preliminar: FacturaPreliminar,
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
): ReactElement {
  const { discountAmount, discountDeadline } = calcularDescuentoProntoPago(
    preliminar.lines,
    lote.earlyPaymentDiscount,
    lote.earlyPaymentDiscountFixedValue,
    lote.discountDeadline,
    copropiedad.discountAppliesWithLateFee,
  );
  const descuento =
    discountAmount > 0 && discountDeadline
      ? { fechaLimite: discountDeadline, monto: discountAmount }
      : null;

  const datos: DatosDocumentoFacturacion = {
    titulo: 'PREFACTURA',
    unitCode: preliminar.unitCode,
    holder: preliminar.holder,
    issueDate: lote.billingDate,
    dueDate: lote.dueDate,
    periodStart: lote.periodStart,
    periodEnd: lote.periodEnd,
    lines: preliminar.lines,
    descuento,
    marcaDuplicado: null,
  };

  return contenidoDocumentoFacturacion(datos, copropiedad);
}

/**
 * React-pdf port of `generarPdfPrefactura` (`prefactura-pdf.ts`, kept
 * unchanged and still wired into the controller) — same shared body as
 * `generarPdfFacturaReactPdf`, no DIAN footer or duplicado stamp, same as
 * the pdf-lib original.
 */
export async function generarPdfPrefacturaReactPdf(
  preliminar: FacturaPreliminar,
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
): Promise<Buffer> {
  return renderizarPdf(reporteDocumento(paginaPrefactura(preliminar, lote, copropiedad)));
}
