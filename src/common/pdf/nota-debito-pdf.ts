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
 *
 * `saldoPendiente` is no longer a field on the (now immutable) document —
 * `NotaDebito.outstandingBalance` is gone precisely so a Nota Débito never
 * changes after issuance (see `SaldoTotalDocumento`'s own docblock). The
 * caller resolves it (same live source `NotasDebitoService.findOne` already
 * reads) and passes it in here, same pattern the JSON mapper uses.
 */
export async function generarPdfNotaDebito(
  nota: NotaDebitoDocument,
  saldoPendiente: number,
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
  if (saldoPendiente > 0) {
    escribirLabelValor(ctx, 'Saldo pendiente:', formatoPeso(saldoPendiente));
  }

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, nota.issueDate.toISOString());
  }

  return ctx.doc.save();
}
