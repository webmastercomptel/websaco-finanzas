import {
  PdfContext,
  crearContexto,
  escribirLinea,
  escribirLabelValor,
  escribirTabla,
  escribirMarcaDuplicado,
  escribirEncabezado,
  formatoPeso,
  formatoFecha,
} from './pdf-helpers';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Generates a real PDF for a Factura (sales invoice). Includes the DIAN
 * resolution text — legally required on Colombian invoices — and the
 * copropiedad header. When duplicado is true, stamps the "DUPLICADO" mark.
 */
export async function generarPdfFactura(
  factura: FacturaDocument,
  resolucion: ResolucionFacturacionDocument,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  // ── Header ──
  escribirEncabezado(
    ctx,
    copropiedad,
    'FACTURA DE VENTA',
    `No. ${factura.fullNumber}`,
  );

  // ── Document info ──
  escribirLabelValor(ctx, 'Fecha de emisión:', formatoFecha(factura.issueDate));
  escribirLabelValor(ctx, 'Fecha de vencimiento:', formatoFecha(factura.dueDate));
  escribirLabelValor(ctx, 'Unidad:', factura.unitCode);
  escribirLabelValor(
    ctx,
    'Periodo:',
    `${formatoFecha(factura.periodStart)} al ${formatoFecha(factura.periodEnd)}`,
  );

  if (factura.holder) {
    const h = factura.holder;
    const idParts = [h.identificationType, h.identificationNumber]
      .filter(Boolean)
      .join(' ');
    escribirLabelValor(ctx, 'Cliente:', h.name);
    if (idParts) escribirLabelValor(ctx, 'Identificación:', idParts);
    if (h.address) escribirLabelValor(ctx, 'Dirección:', h.address);
    if (h.city) escribirLabelValor(ctx, 'Ciudad:', h.city);
  }

  // ── Line items table ──
  const columnas = ['Concepto', 'Base', 'IVA', 'Total'];
  const filas = factura.lines.map((l) => [
    l.conceptName,
    formatoPeso(l.baseAmount),
    `${l.taxRate}%`,
    formatoPeso(l.totalAmount),
  ]);

  if (filas.length > 0) {
    ctx.y -= 6;
    escribirLinea(ctx, 'Detalle de conceptos', { bold: true });
    escribirTabla(ctx, columnas, filas);
  }

  // ── Totals ──
  ctx.y -= 6;
  escribirLabelValor(ctx, 'Subtotal:', formatoPeso(factura.subtotal));
  escribirLabelValor(ctx, 'IVA:', formatoPeso(factura.totalTax));
  escribirLabelValor(ctx, 'Total:', formatoPeso(factura.total));
  if (factura.outstandingBalance > 0) {
    escribirLabelValor(
      ctx,
      'Saldo pendiente:',
      formatoPeso(factura.outstandingBalance),
    );
  }

  // ── DIAN Resolution footer ──
  ctx.y -= 10;
  const vigenteHasta = resolucion.validUntil
    ? ` vigente hasta ${formatoFecha(resolucion.validUntil)}`
    : '';
  const resolucionTexto =
    `Resolución de Facturación DIAN No. ${resolucion.resolutionNumber} ` +
    `del ${formatoFecha(resolucion.validFrom)}. ` +
    `Numeración autorizada de ${resolucion.prefix}${resolucion.rangeFrom} ` +
    `a ${resolucion.prefix}${resolucion.rangeTo}${vigenteHasta}`;
  escribirLinea(ctx, resolucionTexto, { size: 8 });

  // ── Duplicado stamp ──
  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, factura.issueDate.toISOString());
  }

  return ctx.doc.save();
}
