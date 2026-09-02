import {
  crearContexto,
  escribirLabelValor,
  escribirMarcaDuplicado,
  escribirEncabezado,
  formatoPeso,
  formatoFecha,
} from './pdf-helpers';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Generates a real PDF for a NotaDebito (debit note). Simple single-amount
 * document with no line items table.
 */
export async function generarPdfNotaDebito(
  nota: NotaDebitoDocument,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  escribirEncabezado(
    ctx,
    copropiedad,
    'NOTA DE DÉBITO',
    `No. ${nota.fullNumber}`,
  );

  escribirLabelValor(ctx, 'Fecha:', formatoFecha(nota.issueDate));
  escribirLabelValor(ctx, 'Monto total:', formatoPeso(nota.total));
  if (nota.description) {
    escribirLabelValor(ctx, 'Descripción:', nota.description);
  }
  if (nota.outstandingBalance > 0) {
    escribirLabelValor(
      ctx,
      'Saldo pendiente:',
      formatoPeso(nota.outstandingBalance),
    );
  }

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, nota.issueDate.toISOString());
  }

  return ctx.doc.save();
}
