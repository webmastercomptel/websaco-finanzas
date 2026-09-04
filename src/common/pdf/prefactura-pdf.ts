import {
  crearContexto,
  escribirLinea,
  escribirLabelValor,
  escribirTabla,
  escribirEncabezado,
  formatoPeso,
  formatoFecha,
} from './pdf-helpers';
import type { FacturaPreliminar } from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { LoteFacturacionDocument } from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Generates a preview PDF for one unit's not-yet-issued FacturaPreliminar —
 * same layout as `generarPdfFactura`, but for a row that has no `fullNumber`,
 * no reserved DIAN resolution, and no `outstandingBalance` yet (all three
 * only exist once `consolidar()` turns this preliminar into a real Factura).
 * Dates come from the parent Lote — a preliminar itself carries none — and
 * there is no duplicado stamp, since nothing has been issued to duplicate.
 * Modeled on `generarPdfEstadoCuenta`: takes an already-computed shape, not a
 * persisted document, because a prefactura is never persisted on its own.
 */
export async function generarPdfPrefactura(
  preliminar: FacturaPreliminar,
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  // ── Header ──
  escribirEncabezado(ctx, copropiedad, 'PREFACTURA', 'Borrador — sin numerar');

  // ── Document info ──
  escribirLabelValor(
    ctx,
    'Fecha de facturación:',
    formatoFecha(lote.billingDate),
  );
  escribirLabelValor(ctx, 'Fecha de vencimiento:', formatoFecha(lote.dueDate));
  escribirLabelValor(ctx, 'Inmueble:', preliminar.unitCode);
  escribirLabelValor(
    ctx,
    'Periodo:',
    `${formatoFecha(lote.periodStart)} al ${formatoFecha(lote.periodEnd)}`,
  );

  if (preliminar.holder) {
    const h = preliminar.holder;
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
  const filas = preliminar.lines.map((l) => [
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

  // ── Totals ── (no "Saldo pendiente" — this row has not been consolidado
  // into a Factura yet, so there is nothing owed to report)
  ctx.y -= 6;
  escribirLabelValor(ctx, 'Subtotal:', formatoPeso(preliminar.subtotal));
  escribirLabelValor(ctx, 'IVA:', formatoPeso(preliminar.totalTax));
  escribirLabelValor(ctx, 'Total:', formatoPeso(preliminar.total));

  // ── Footer note ──
  ctx.y -= 10;
  escribirLinea(
    ctx,
    'Este documento es una vista previa y no constituye una factura de venta. ' +
      'Los valores pueden cambiar hasta que el lote se consolide.',
    { size: 8 },
  );

  return ctx.doc.save();
}
