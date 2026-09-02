import {
  crearContexto,
  escribirLabelValor,
  escribirTabla,
  escribirMarcaDuplicado,
  escribirEncabezado,
  formatoPeso,
  formatoFecha,
} from './pdf-helpers';
import type { NotaContableDocument } from '../../database/schemas/notas-contables/nota-contable.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Generates a real PDF for a NotaContable (accounting reclassification note).
 * Shows origin→destination concept movement.
 */
export async function generarPdfNotaContable(
  nota: NotaContableDocument,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  escribirEncabezado(
    ctx,
    copropiedad,
    'NOTA CONTABLE',
    `No. ${nota.fullNumber}`,
  );

  // ── Document info ──
  const fechaCreacion = (nota as unknown as { createdAt?: Date }).createdAt;
  if (fechaCreacion) {
    escribirLabelValor(ctx, 'Fecha:', formatoFecha(fechaCreacion));
  }
  escribirLabelValor(ctx, 'Monto:', formatoPeso(nota.monto));
  escribirLabelValor(ctx, 'Descripción:', nota.description);

  // ── Origin/Destination table ──
  ctx.y -= 6;
  const columnas = ['Concepto', 'Tipo'];
  const filas = [
    [
      nota.conceptoOrigenId.toString(),
      'Origen (débito)',
    ],
    [
      nota.conceptoDestinoId.toString(),
      'Destino (crédito)',
    ],
  ];
  escribirTabla(ctx, columnas, filas);

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, fechaCreacion?.toISOString() ?? null);
  }

  return ctx.doc.save();
}
