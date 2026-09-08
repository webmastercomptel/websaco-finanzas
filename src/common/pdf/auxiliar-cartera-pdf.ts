import { rgb } from 'pdf-lib';
import {
  crearContexto,
  escribirEncabezado,
  escribirLabelValor,
  escribirLinea,
  formatoFecha,
  formatoPeso,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaAuxiliarCartera } from '../../contracts';

const COLUMNAS = [
  'Fecha',
  'Tipo',
  'Nº Doc',
  'Concepto',
  'Ref/Cruce',
  'Débito',
  'Crédito',
  'Saldo',
];

/**
 * Generates a real PDF for the Auxiliar de Cartera ledger: one inmueble's
 * movements across all five document types for a date range, opening on
 * "Saldo Anterior" and closing on the period's totals — mirrors the on-screen
 * table exactly, including the balance columns the plain `escribirTabla`
 * heuristic (last N columns numeric) can't express, since Débito/Crédito can
 * each be blank on any given row.
 */
export async function generarPdfAuxiliarCartera(
  reporte: RespuestaAuxiliarCartera,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const ctx = await crearContexto({ orientacion: 'horizontal' });

  escribirEncabezado(
    ctx,
    copropiedad,
    'AUXILIAR DE CARTERA',
    `Inmueble ${reporte.inmuebleCodigo}${reporte.propietario ? ` — ${reporte.propietario}` : ''} — ${formatoFecha(reporte.desde)} al ${formatoFecha(reporte.hasta)}`,
  );

  const colCount = COLUMNAS.length;
  const colWidth = ctx.contentWidth / colCount;
  // Débito, Crédito y Saldo (últimas 3) van a la derecha.
  const primeraNumerica = colCount - 3;
  const margenIzquierdo = 50;

  const dibujarFila = (
    celdas: string[],
    opciones?: { bold?: boolean },
  ): void => {
    const font = opciones?.bold ? ctx.fontBold : ctx.font;
    for (let i = 0; i < colCount; i++) {
      const isNumeric = i >= primeraNumerica;
      const texto = celdas[i] ?? '';
      const textWidth = font.widthOfTextAtSize(texto, 10);
      const x = isNumeric
        ? margenIzquierdo + colWidth * (i + 1) - textWidth - 4
        : margenIzquierdo + colWidth * i + 4;
      ctx.page.drawText(texto, {
        x,
        y: ctx.y,
        size: 10,
        font,
        color: rgb(0, 0, 0),
      });
    }
    ctx.y -= 14;
    if (ctx.y < 50) {
      ctx.page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
      ctx.y = ctx.pageHeight - 50;
    }
  };

  // Header row
  dibujarFila(COLUMNAS, { bold: true });
  ctx.page.drawLine({
    start: { x: margenIzquierdo, y: ctx.y + 4 },
    end: { x: margenIzquierdo + ctx.contentWidth, y: ctx.y + 4 },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  ctx.y -= 7;

  // "Saldo Anterior" row
  dibujarFila(
    [
      '',
      '',
      '',
      'Saldo Anterior',
      '',
      '',
      '',
      formatoPeso(reporte.saldoInicial),
    ],
    { bold: true },
  );

  // Movement rows
  for (const m of reporte.movimientos) {
    dibujarFila([
      formatoFecha(m.fecha),
      m.tipo,
      m.numeroCompleto,
      m.concepto,
      m.refCruce ?? '',
      m.debito != null ? formatoPeso(m.debito) : '',
      m.credito != null ? formatoPeso(m.credito) : '',
      formatoPeso(m.saldo),
    ]);
  }

  ctx.page.drawLine({
    start: { x: margenIzquierdo, y: ctx.y + 4 },
    end: { x: margenIzquierdo + ctx.contentWidth, y: ctx.y + 4 },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  ctx.y -= 10;

  escribirLabelValor(
    ctx,
    'Total Débitos Período:',
    formatoPeso(reporte.totalDebitos),
  );
  escribirLabelValor(
    ctx,
    'Total Créditos Período:',
    formatoPeso(reporte.totalCreditos),
  );
  escribirLabelValor(ctx, 'Saldo Final:', formatoPeso(reporte.saldoFinal));

  if (reporte.movimientos.length === 0) {
    ctx.y -= 4;
    escribirLinea(
      ctx,
      'Este inmueble no tiene movimientos en el rango seleccionado',
    );
  }

  return ctx.doc.save();
}
