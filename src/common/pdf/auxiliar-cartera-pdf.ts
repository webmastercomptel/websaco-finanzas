import { rgb } from 'pdf-lib';
import {
  crearContexto,
  dibujarEncabezadoDocumento,
  formatoFecha,
  formatoPeso,
  truncateToFit,
  type PdfContext,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaAuxiliarCartera } from '../../contracts';

const MARGIN_LEFT = 50;
const GRIS_CLARO = rgb(0.9, 0.9, 0.9);

/** Column widths for the movements table, left to right — summing to
 *  exactly `ctx.contentWidth` (512pt on Letter portrait). "Concepto" gets
 *  the lion's share since it's free text ("Administración Enero", …);
 *  "Tipo"/"Nº Doc" are short, fixed identifiers. Not `escribirTabla`
 *  (equal-width columns) —8 equal columns at portrait width would be too
 *  cramped for Concepto to read. */
const ANCHOS_COLUMNA = {
  fecha: 55,
  tipo: 30,
  numeroDoc: 50,
  concepto: 140,
  refCruce: 55,
  debito: 60,
  credito: 60,
  saldo: 62,
};

const COLUMNAS = [
  { titulo: 'Fecha', ancho: ANCHOS_COLUMNA.fecha, numerica: false },
  { titulo: 'Tipo', ancho: ANCHOS_COLUMNA.tipo, numerica: false },
  { titulo: 'Nº Doc', ancho: ANCHOS_COLUMNA.numeroDoc, numerica: false },
  { titulo: 'Concepto', ancho: ANCHOS_COLUMNA.concepto, numerica: false },
  { titulo: 'Ref/Cruce', ancho: ANCHOS_COLUMNA.refCruce, numerica: false },
  { titulo: 'Débito', ancho: ANCHOS_COLUMNA.debito, numerica: true },
  { titulo: 'Crédito', ancho: ANCHOS_COLUMNA.credito, numerica: true },
  { titulo: 'Saldo', ancho: ANCHOS_COLUMNA.saldo, numerica: true },
];

/**
 * Generates a real PDF for the Auxiliar de Cartera ledger: one inmueble's
 * movements across all five document types for a date range, opening on
 * "Saldo Anterior" and closing on "Saldo Final" — mirrors the on-screen
 * table exactly, including the balance columns the plain `escribirTabla`
 * heuristic (last N columns numeric) can't express, since Débito/Crédito can
 * each be blank on any given row.
 *
 * Letter portrait (vertical) and styled after the Recibo/Nota Crédito print
 * — same gray-banner masthead (`dibujarEncabezadoDocumento`) and the same
 * gray-bar "Totales" treatment for its own bookend rows — instead of the
 * generic text-only `escribirEncabezado`/`escribirLabelValor` this report
 * used before.
 */
export async function generarPdfAuxiliarCartera(
  reporte: RespuestaAuxiliarCartera,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  await dibujarEncabezadoDocumento(ctx, copropiedad, 'Auxiliar de Cartera');
  dibujarBloqueAuxiliar(ctx, reporte);
  dibujarTablaMovimientos(ctx, reporte);

  return ctx.doc.save();
}

/** Left column (inmueble / titular) alongside Periodo on the right, both
 *  right-aligned to the same edge as the Recibo print's own info block —
 *  no Valor (this report has no single amount) and no "Por Concepto de"
 *  (nothing here settles one specific concepto). */
function dibujarBloqueAuxiliar(
  ctx: PdfContext,
  reporte: RespuestaAuxiliarCartera,
): void {
  const inicioBloque = ctx.y;
  const filas: [string, string][] = [
    ['Inmueble :', reporte.inmuebleCodigo],
    ['Nombre :', reporte.propietario ?? '—'],
  ];
  for (const [label, valor] of filas) {
    ctx.page.drawText(label, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: 10,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
    ctx.page.drawText(valor, {
      x: MARGIN_LEFT + 95,
      y: ctx.y,
      size: 10,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    ctx.y -= 15;
  }

  const periodoTexto = `Periodo : ${formatoFecha(reporte.desde)} al ${formatoFecha(reporte.hasta)}`;
  const periodoAncho = ctx.font.widthOfTextAtSize(periodoTexto, 10);
  ctx.page.drawText(periodoTexto, {
    x: MARGIN_LEFT + ctx.contentWidth - periodoAncho,
    y: inicioBloque,
    size: 10,
    font: ctx.font,
    color: rgb(0, 0, 0),
  });

  ctx.y -= 20;
}

/** The movements table itself, opening on a gray-bar "Saldo Anterior" row
 *  and closing on a gray-bar "Saldo Final" row — same bold, gray-shaded
 *  treatment as the Recibo print's own "Totales" row, replacing the three
 *  separate label/value lines (Total Débitos/Créditos/Saldo Final) this
 *  report used before. */
function dibujarTablaMovimientos(
  ctx: PdfContext,
  reporte: RespuestaAuxiliarCartera,
): void {
  dibujarFila(
    ctx,
    COLUMNAS.map((c) => ({ texto: c.titulo, numerica: c.numerica })),
    { bold: true },
  );
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y + 5 },
    end: { x: MARGIN_LEFT + ctx.contentWidth, y: ctx.y + 5 },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  ctx.y -= 10;

  dibujarFilaBarra(ctx, [
    '',
    '',
    '',
    'Saldo Anterior',
    '',
    '',
    '',
    formatoPeso(reporte.saldoInicial),
  ]);

  for (const m of reporte.movimientos) {
    dibujarFila(ctx, [
      { texto: formatoFecha(m.fecha), numerica: false },
      { texto: m.tipo, numerica: false },
      { texto: m.numeroCompleto, numerica: false },
      { texto: m.concepto, numerica: false, truncar: true },
      { texto: m.refCruce ?? '', numerica: false, truncar: true },
      { texto: m.debito ? formatoPeso(m.debito) : '', numerica: true },
      { texto: m.credito ? formatoPeso(m.credito) : '', numerica: true },
      { texto: formatoPeso(m.saldo), numerica: true },
    ]);
  }

  if (reporte.movimientos.length === 0) {
    asegurarEspacio(ctx);
    const mensaje = truncateToFit(
      ctx.font,
      'Este inmueble no tiene movimientos en el rango seleccionado',
      9,
      ctx.contentWidth - 8,
    );
    ctx.page.drawText(mensaje, {
      x: MARGIN_LEFT + 4,
      y: ctx.y,
      size: 9,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    ctx.y -= 14;
  }

  // Un renglón de aire entre el asiento y su total — mismo criterio que el
  // print de Recibo.
  ctx.y -= 5;
  dibujarFilaBarra(ctx, [
    '',
    '',
    '',
    'Saldo Final',
    '',
    formatoPeso(reporte.totalDebitos),
    formatoPeso(reporte.totalCreditos),
    formatoPeso(reporte.saldoFinal),
  ]);
}

/** Draws one row of fixed-width cells, left-aligned for text columns and
 *  right-aligned (with a small right padding) for numeric ones, advancing
 *  `ctx.y` afterward and breaking to a new page when the cursor runs out of
 *  room. Free-text cells (`truncar: true`) are clipped to their own column
 *  width instead of overflowing into the next one. */
function dibujarFila(
  ctx: PdfContext,
  celdas: { texto: string; numerica: boolean; truncar?: boolean }[],
  opciones?: { bold?: boolean },
): void {
  asegurarEspacio(ctx);

  const font = opciones?.bold ? ctx.fontBold : ctx.font;
  const size = 9;
  let x = MARGIN_LEFT;
  celdas.forEach((celda, i) => {
    const ancho = COLUMNAS[i].ancho;
    if (celda.texto) {
      const texto = celda.truncar
        ? truncateToFit(font, celda.texto, size, ancho - 8)
        : celda.texto;
      const textWidth = font.widthOfTextAtSize(texto, size);
      const cellX = celda.numerica ? x + ancho - textWidth - 4 : x + 4;
      ctx.page.drawText(texto, {
        x: cellX,
        y: ctx.y,
        size,
        font,
        color: rgb(0, 0, 0),
      });
    }
    x += ancho;
  });
  ctx.y -= 14;
}

/** Page-break check shared by `dibujarFila` and `dibujarFilaBarra` — the
 *  latter must run it BEFORE drawing its gray background, or a break
 *  triggered inside `dibujarFila` would leave the bar on the old page and
 *  its text on the new one. */
function asegurarEspacio(ctx: PdfContext): void {
  if (ctx.y < 90) {
    ctx.page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
    ctx.y = ctx.pageHeight - 50;
  }
}

/** A bold row on a gray bar — "Saldo Anterior"/"Saldo Final", same visual
 *  treatment as the Recibo print's own "Totales" row. */
function dibujarFilaBarra(ctx: PdfContext, valores: string[]): void {
  asegurarEspacio(ctx);
  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: ctx.y - 4,
    width: ctx.contentWidth,
    height: 18,
    color: GRIS_CLARO,
  });
  dibujarFila(
    ctx,
    valores.map((texto, i) => ({ texto, numerica: COLUMNAS[i].numerica })),
    { bold: true },
  );
}
