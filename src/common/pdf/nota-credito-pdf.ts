import {
  crearContexto,
  escribirLinea,
  escribirLabelValor,
  escribirTabla,
  escribirMarcaDuplicado,
  escribirEncabezado,
  formatoPeso,
  formatoFecha,
} from './pdf-helpers';
import type { NotaCreditoDocument } from '../../database/schemas/notas-credito/nota-credito.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const MOTIVOS_LABELS: Record<string, string> = {
  error_facturacion: 'Error de facturación',
  descuento_comercial: 'Descuento comercial',
  anulacion_documento: 'Anulación de documento',
  otro: 'Otro',
};

/**
 * Generates a real PDF for a NotaCredito (credit note). Shows the anchor
 * invoice reference, reason, distribution, and application lines.
 */
export async function generarPdfNotaCredito(
  nota: NotaCreditoDocument,
  aplicaciones: AplicacionCarteraDocument[],
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  escribirEncabezado(
    ctx,
    copropiedad,
    'NOTA DE CRÉDITO',
    `No. ${nota.fullNumber}`,
  );

  // ── Document info ──
  // NotaCredito has no issueDate — createdAt is a timestamps runtime field
  const fechaCreacion = (nota as unknown as { createdAt?: Date }).createdAt;
  if (fechaCreacion) {
    escribirLabelValor(ctx, 'Fecha:', formatoFecha(fechaCreacion));
  }
  escribirLabelValor(ctx, 'Monto total:', formatoPeso(nota.totalAmount));
  escribirLabelValor(
    ctx,
    'Motivo:',
    MOTIVOS_LABELS[nota.reason] ?? nota.reason,
  );
  if (nota.notes) {
    escribirLabelValor(ctx, 'Notas:', nota.notes);
  }
  if (nota.appliedAmount > 0) {
    escribirLabelValor(ctx, 'Monto aplicado:', formatoPeso(nota.appliedAmount));
  }
  if (nota.unappliedAmount > 0) {
    escribirLabelValor(
      ctx,
      'Saldo sin aplicar (anticipo):',
      formatoPeso(nota.unappliedAmount),
    );
  }

  // ── Distribution table ──
  if (nota.distribution.length > 0) {
    ctx.y -= 6;
    escribirLinea(ctx, 'Distribución por concepto', { bold: true });
    const columnas = ['Concepto', 'Monto'];
    const filas = nota.distribution.map((d) => [
      d.conceptoId.toString(),
      formatoPeso(d.amount),
    ]);
    escribirTabla(ctx, columnas, filas);
  }

  // ── Applications table ──
  if (aplicaciones.length > 0) {
    ctx.y -= 6;
    escribirLinea(ctx, 'Aplicaciones', { bold: true });
    const columnas = ['Tipo', 'Documento', 'Monto'];
    const filas = aplicaciones.map((a) => [
      a.sourceType === 'RC' ? 'Recibo' : 'Nota Crédito',
      a.documentType,
      formatoPeso(a.amountApplied),
    ]);
    escribirTabla(ctx, columnas, filas);
  }

  // NotaCredito has no issueDate field — use null for the duplicado stamp
  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, null);
  }

  return ctx.doc.save();
}
