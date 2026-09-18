import type { ReactElement } from 'react';
import { reporteDocumento, renderizarPdf } from './react/document';
import { contenidoDocumentoFacturacion } from './factura-pdf';
import { calcularDescuentoProntoPago } from '../facturacion/descuento-pronto-pago.util';
import type {
  DatosDocumentoFacturacion,
  DatosVisualesFactura,
} from './factura-pdf';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * One Preliminar's page content — factored out so `prefacturas-lote-pdf.ts`
 * can reuse it across N pages of one `<Document>` instead of merging N
 * independently rendered PDFs (see `paginaFactura`'s docblock for why).
 */
export function paginaPrefactura(
  preliminar: FacturaPreliminar,
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
  datosVisuales?: DatosVisualesFactura,
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
    referenciaPago: datosVisuales?.referencia ?? null,
    totalAnticipos: datosVisuales?.totalAnticipos ?? 0,
  };

  return contenidoDocumentoFacturacion(datos, copropiedad);
}

/**
 * Generates a preview PDF for one unit's not-yet-issued FacturaPreliminar.
 * Same layout as `generarPdfFactura` — per product decision, a prefactura
 * and a factura must look identical — built through the same shared
 * renderer (`contenidoDocumentoFacturacion`); the only visible difference is
 * the "PREFACTURA" title in place of the document's real name. Dates come
 * from the parent Lote — a preliminar itself carries none — and there is no
 * DIAN footer or duplicado stamp, since nothing has been issued yet to
 * authorise or duplicate. React-pdf, built directly (no pdf-lib version kept
 * behind a `?version=` toggle — direct cutover, same as the rest of this
 * migration).
 */
export async function generarPdfPrefactura(
  preliminar: FacturaPreliminar,
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
  datosVisuales?: DatosVisualesFactura,
): Promise<Buffer> {
  return renderizarPdf(
    reporteDocumento(
      paginaPrefactura(preliminar, lote, copropiedad, datosVisuales),
    ),
  );
}
