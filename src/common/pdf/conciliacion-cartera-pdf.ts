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
  // Concepto's own label ("Anulación de Recibos de Caja", …) runs far
  // longer than a short document number — an equal five-way split (the
  // default) ran Desde's text right into Concepto's own, since `escribirTabla`
  // never truncates data cells. Concepto gets the lion's share; Desde/Hasta
  // only ever hold one document number each.
  escribirTabla(ctx, COLUMNAS, filas, {
    columnasNumericas: 2,
    anchosRelativos: [3, 1, 1, 1.3, 1.3],
  });

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

  ctx.y -= 10;
  escribirLinea(ctx, 'Anticipos Pendientes al Final del Período', {
    bold: true,
  });
  if (reporte.anticiposPendientes.length === 0) {
    escribirLinea(ctx, 'No hay anticipos pendientes a esa fecha.');
  } else {
    escribirTabla(
      ctx,
      ['Inmueble', 'Fecha', 'No. Recibo', 'Valor'],
      reporte.anticiposPendientes.map((a) => [
        a.inmuebleCodigo,
        formatoFecha(a.fecha),
        a.numeroRecibo,
        formatoPeso(a.valor),
      ]),
      { columnasNumericas: 1 },
    );
  }

  return ctx.doc.save();
}
