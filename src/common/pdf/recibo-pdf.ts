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
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Generates a real PDF for a Recibo (cash receipt). Shows payment details
 * and application lines. Stamps DUPLICADO when requested.
 */
export async function generarPdfRecibo(
  recibo: ReciboDocument,
  aplicaciones: AplicacionCarteraDocument[],
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  escribirEncabezado(
    ctx,
    copropiedad,
    'RECIBO DE PAGO',
    `No. ${recibo.fullNumber}`,
  );

  // ── Payment info ──
  const PAYMENT_LABELS: Record<string, string> = {
    transferencia: 'Transferencia',
    cheque: 'Cheque',
    pse: 'PSE',
    efectivo: 'Efectivo',
  };

  escribirLabelValor(ctx, 'Fecha:', formatoFecha(recibo.receivedDate));
  escribirLabelValor(
    ctx,
    'Monto recibido:',
    formatoPeso(recibo.receivedAmount),
  );
  escribirLabelValor(
    ctx,
    'Forma de pago:',
    PAYMENT_LABELS[recibo.paymentMethod] ?? recibo.paymentMethod,
  );
  escribirLabelValor(ctx, 'Cuenta destino:', recibo.destinationAccount);
  if (recibo.reference) {
    escribirLabelValor(ctx, 'Referencia:', recibo.reference);
  }
  if (recibo.notes) {
    escribirLabelValor(ctx, 'Notas:', recibo.notes);
  }
  if (recibo.appliedAmount > 0) {
    escribirLabelValor(
      ctx,
      'Monto aplicado:',
      formatoPeso(recibo.appliedAmount),
    );
  }
  if (recibo.unappliedAmount > 0) {
    escribirLabelValor(
      ctx,
      'Saldo sin aplicar (anticipo):',
      formatoPeso(recibo.unappliedAmount),
    );
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

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, recibo.receivedDate.toISOString());
  }

  return ctx.doc.save();
}
