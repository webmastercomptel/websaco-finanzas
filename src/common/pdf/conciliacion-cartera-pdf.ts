import { rgb } from 'pdf-lib';
import {
  crearContexto,
  escribirEncabezado,
  escribirLabelValor,
  escribirLinea,
  escribirTabla,
  formatoFecha,
  formatoPeso,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaConciliacionCartera } from '../../contracts';

const COLUMNAS = [
  'Concepto',
  'Desde',
  'Hasta',
  'Valor Débito',
  'Valor Crédito',
];

/**
 * Generates a real PDF for the Conciliación de Cartera control report —
 * mirrors the on-screen table exactly, ten fixed concepts followed by the
 * calculated-vs-real balance comparison (see the service's own docblock on
 * what `diferencia` means).
 */
export async function generarPdfConciliacionCartera(
  reporte: RespuestaConciliacionCartera,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  escribirEncabezado(
    ctx,
    copropiedad,
    'CONCILIACIÓN DE CARTERA',
    `Período ${formatoFecha(reporte.periodStart)} al ${formatoFecha(reporte.periodEnd)}`,
  );

  escribirLabelValor(
    ctx,
    'Saldo Anterior:',
    formatoPeso(reporte.saldoAnterior),
  );
  ctx.y -= 6;

  const filas = reporte.conceptos.map((c) => [
    c.etiqueta,
    c.desde ?? '',
    c.hasta ?? '',
    c.valorDebito > 0 ? formatoPeso(c.valorDebito) : '',
    c.valorCredito > 0 ? formatoPeso(c.valorCredito) : '',
  ]);
  escribirTabla(ctx, COLUMNAS, filas, { columnasNumericas: 2 });

  escribirLabelValor(
    ctx,
    'Total Valor Débito:',
    formatoPeso(reporte.totalDebito),
  );
  escribirLabelValor(
    ctx,
    'Total Valor Crédito:',
    formatoPeso(reporte.totalCredito),
  );
  ctx.y -= 4;
  escribirLabelValor(
    ctx,
    'Saldo de Cartera Calculado:',
    formatoPeso(reporte.saldoCarteraCalculado),
  );
  escribirLabelValor(
    ctx,
    'Saldo de Cartera:',
    formatoPeso(reporte.saldoCarteraReal),
  );
  escribirLabelValor(
    ctx,
    'Diferencia a Conciliar:',
    formatoPeso(reporte.diferencia),
  );

  if (reporte.diferencia !== 0) {
    ctx.y -= 6;
    ctx.page.drawText(
      'Esta copropiedad presenta diferencias por conciliar en el período seleccionado.',
      {
        x: 50,
        y: ctx.y,
        size: 10,
        font: ctx.fontBold,
        color: rgb(0.7, 0, 0),
      },
    );
    ctx.y -= 14;
  }

  if (
    reporte.conceptos.every((c) => c.valorDebito === 0 && c.valorCredito === 0)
  ) {
    ctx.y -= 4;
    escribirLinea(
      ctx,
      'No se registraron movimientos de cartera en el período seleccionado.',
    );
  }

  return ctx.doc.save();
}
