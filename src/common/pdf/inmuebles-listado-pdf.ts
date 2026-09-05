import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import { truncateToFit } from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/** One column of the "valores recurrentes" block — `intereses` excluded
 *  (see the note on `InmueblesReporteService`), so every column here is a
 *  genuine flat monthly amount. */
export interface ConceptoListado {
  id: string;
  nombre: string;
}

export interface InmuebleListadoItem {
  codigo: string;
  titular: string;
  area: number | null;
  coeficiente: number | null;
  /** Keyed by `ConceptoListado.id` — 0 for a concept with no ValorRecurrente
   *  row for this unit, same convention as the "Valores Recurrentes" tab. */
  valores: Record<string, number>;
}

// Landscape Letter — a roster with several concept columns needs the extra
// width more than it needs portrait orientation, unlike every other PDF
// builder here (a single facturación document). Kept private to this file
// rather than folded into `pdf-helpers.ts`'s constants, which every other
// (portrait) document builder depends on.
const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const MARGIN_LEFT = 30;
const MARGIN_RIGHT = 30;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const CONTENT_TOP_Y = PAGE_HEIGHT - 30;
const CONTENT_BOTTOM_Y = 34; // leaves room for the footer below it
const FOOTER_Y = 18;
const LINE_HEIGHT = 12;
const FONT_SIZE = 8;
const HEADER_NAME_SIZE = 12;
const HEADER_LINE_SIZE = 9;

interface Contexto {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  y: number;
  copropiedad: CopropiedadDocument;
  titulo: string;
  fechaGeneracion: Date;
}

/**
 * Generates a printable roster of every active unit in the coproperty: código,
 * titular, área, participación (coeficiente), and one column per recurring
 * charge. One row per unit rather than one document per unit, unlike every
 * other PDF builder here — this is a listing, not an individual document.
 *
 * Every page repeats the same three-line header (nombre, NIT, título +
 * fecha de generación) and gets a "Página x/xxx" footer once the final page
 * count is known — a roster long enough to paginate is exactly the case
 * where a reader needs both on every sheet, not just the first.
 */
export async function generarPdfListadoInmuebles(
  copropiedad: CopropiedadDocument,
  inmuebles: InmuebleListadoItem[],
  conceptos: ConceptoListado[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ctx: Contexto = {
    doc,
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    font,
    fontBold,
    y: CONTENT_TOP_Y,
    copropiedad,
    titulo: 'LISTADO DE INMUEBLES',
    fechaGeneracion: new Date(),
  };
  escribirEncabezadoPagina(ctx);

  const columnas = [
    'Código',
    'Titular',
    'Área',
    'Particip. %',
    ...conceptos.map((c) => c.nombre),
  ];
  // Only Código/Titular are text — every other column here is a number.
  const primeraColumnaNumerica = 2;
  const anchos = anchosDeColumna(columnas.length);

  const filas = inmuebles.map((inm) => [
    inm.codigo,
    inm.titular || '—',
    inm.area != null ? inm.area.toFixed(2) : '—',
    inm.coeficiente != null ? inm.coeficiente.toFixed(4) : '—',
    ...conceptos.map((c) => {
      const monto = inm.valores[c.id] ?? 0;
      return monto > 0 ? monto.toLocaleString('es-CO') : '—';
    }),
  ]);

  escribirEncabezadoTabla(ctx, columnas, anchos, primeraColumnaNumerica);
  for (const fila of filas) {
    if (ctx.y < CONTENT_BOTTOM_Y + LINE_HEIGHT) {
      ctx.page = ctx.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      ctx.y = CONTENT_TOP_Y;
      escribirEncabezadoPagina(ctx);
      escribirEncabezadoTabla(ctx, columnas, anchos, primeraColumnaNumerica);
    }
    escribirFilaTabla(ctx, fila, anchos, primeraColumnaNumerica);
  }

  escribirPiesDePagina(ctx);

  return ctx.doc.save();
}

/** Even column widths, same rule the previous version used — good enough
 *  for the handful of columns a coproperty's own concepts add. */
function anchosDeColumna(cantidad: number): number[] {
  const ancho = CONTENT_WIDTH / cantidad;
  return Array.from({ length: cantidad }, () => ancho);
}

/**
 * The three-line header every page repeats: coproperty name, its NIT, then
 * the report title with the generation timestamp at the right — not
 * centered, unlike `escribirEncabezado` in `pdf-helpers.ts`, since a report
 * title shares its line with the timestamp instead of standing alone.
 */
function escribirEncabezadoPagina(ctx: Contexto): void {
  ctx.page.drawText(ctx.copropiedad.name, {
    x: MARGIN_LEFT,
    y: ctx.y,
    size: HEADER_NAME_SIZE,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  ctx.y -= LINE_HEIGHT + 3;

  const nit = ctx.copropiedad.taxId
    ? ctx.copropiedad.taxIdVerificationDigit
      ? `NIT ${ctx.copropiedad.taxId}-${ctx.copropiedad.taxIdVerificationDigit}`
      : `NIT ${ctx.copropiedad.taxId}`
    : null;
  if (nit) {
    ctx.page.drawText(nit, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: HEADER_LINE_SIZE,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
  }
  ctx.y -= LINE_HEIGHT + 3;

  ctx.page.drawText(ctx.titulo, {
    x: MARGIN_LEFT,
    y: ctx.y,
    size: HEADER_LINE_SIZE,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  const fecha = formatoFechaHora(ctx.fechaGeneracion);
  const fechaWidth = ctx.font.widthOfTextAtSize(fecha, HEADER_LINE_SIZE);
  ctx.page.drawText(fecha, {
    x: MARGIN_LEFT + CONTENT_WIDTH - fechaWidth,
    y: ctx.y,
    size: HEADER_LINE_SIZE,
    font: ctx.font,
    color: rgb(0.3, 0.3, 0.3),
  });
  ctx.y -= LINE_HEIGHT + 4;

  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y + 6 },
    end: { x: MARGIN_LEFT + CONTENT_WIDTH, y: ctx.y + 6 },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  ctx.y -= LINE_HEIGHT - 4;
}

function escribirEncabezadoTabla(
  ctx: Contexto,
  columnas: string[],
  anchos: number[],
  primeraColumnaNumerica: number,
): void {
  let x = MARGIN_LEFT;
  for (let i = 0; i < columnas.length; i++) {
    const isNumeric = i >= primeraColumnaNumerica;
    const texto = truncateToFit(
      ctx.fontBold,
      columnas[i],
      FONT_SIZE,
      anchos[i] - 6,
    );
    const textWidth = ctx.fontBold.widthOfTextAtSize(texto, FONT_SIZE);
    const tx = isNumeric ? x + anchos[i] - textWidth - 4 : x + 4;
    ctx.page.drawText(texto, {
      x: tx,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
    x += anchos[i];
  }
  ctx.y -= LINE_HEIGHT;
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y + 4 },
    end: { x: MARGIN_LEFT + CONTENT_WIDTH, y: ctx.y + 4 },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  ctx.y -= LINE_HEIGHT - 6;
}

function escribirFilaTabla(
  ctx: Contexto,
  fila: string[],
  anchos: number[],
  primeraColumnaNumerica: number,
): void {
  let x = MARGIN_LEFT;
  for (let i = 0; i < fila.length; i++) {
    const isNumeric = i >= primeraColumnaNumerica;
    const texto = truncateToFit(ctx.font, fila[i], FONT_SIZE, anchos[i] - 6);
    const textWidth = ctx.font.widthOfTextAtSize(texto, FONT_SIZE);
    const tx = isNumeric ? x + anchos[i] - textWidth - 4 : x + 4;
    ctx.page.drawText(texto, {
      x: tx,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    x += anchos[i];
  }
  ctx.y -= LINE_HEIGHT;
}

/** Stamped once at the end, right-aligned, when every page — and so the
 *  total page count — already exists; doing this per-page while writing
 *  the table would mean guessing a total that isn't known yet. */
function escribirPiesDePagina(ctx: Contexto): void {
  const paginas = ctx.doc.getPages();
  paginas.forEach((pagina, indice) => {
    const texto = `Página ${indice + 1}/${paginas.length}`;
    const textWidth = ctx.font.widthOfTextAtSize(texto, HEADER_LINE_SIZE);
    pagina.drawText(texto, {
      x: MARGIN_LEFT + CONTENT_WIDTH - textWidth,
      y: FOOTER_Y,
      size: HEADER_LINE_SIZE,
      font: ctx.font,
      color: rgb(0.3, 0.3, 0.3),
    });
  });
}

function formatoFechaHora(fecha: Date): string {
  const dia = fecha.toLocaleDateString('es-CO');
  const hora = fecha.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${dia} ${hora}`;
}
