import {
  PDFDocument,
  PDFPage,
  PDFFont,
  StandardFonts,
  rgb,
  degrees,
} from 'pdf-lib';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

export interface PdfContext {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  /** Current vertical cursor, top-down. Mutated by every write helper. */
  y: number;
}

const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const PAGE_WIDTH = 612; // Letter
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const TOP_Y = PAGE_HEIGHT - 50;
const BOTTOM_Y = 50;
const LINE_HEIGHT = 14;
const FONT_SIZE = 10;
const HEADER_FONT_SIZE = 14;

/**
 * Creates a fresh PdfContext on a single Letter page with Helvetica embedded.
 * No filesystem writes — the PDF lives entirely in memory until saved.
 */
export async function crearContexto(): Promise<PdfContext> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, page, font, fontBold, y: TOP_Y };
}

/** Advances y to the next line. Adds a new page when the cursor reaches the bottom. */
function saltarLinea(ctx: PdfContext, veces = 1): void {
  ctx.y -= LINE_HEIGHT * veces;
  if (ctx.y < BOTTOM_Y) {
    ctx.page = ctx.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    ctx.y = TOP_Y;
  }
}

/**
 * Writes a single line of text at the current cursor position.
 * Advances y by one line height. Truncates text that exceeds the content width.
 */
export function escribirLinea(
  ctx: PdfContext,
  texto: string,
  opciones?: { bold?: boolean; size?: number },
): void {
  const font = opciones?.bold ? ctx.fontBold : ctx.font;
  const size = opciones?.size ?? FONT_SIZE;
  const truncated =
    font.widthOfTextAtSize(texto, size) > CONTENT_WIDTH
      ? truncateToFit(font, texto, size, CONTENT_WIDTH)
      : texto;
  ctx.page.drawText(truncated, {
    x: MARGIN_LEFT,
    y: ctx.y,
    size,
    font,
    color: rgb(0, 0, 0),
  });
  saltarLinea(ctx);
}

/**
 * Writes a label/value pair on one row: label left-aligned, value right-aligned.
 * If the combined width exceeds the content area, the value wraps to the next line.
 */
export function escribirLabelValor(
  ctx: PdfContext,
  label: string,
  valor: string,
): void {
  const labelWidth = ctx.font.widthOfTextAtSize(label, FONT_SIZE);
  const valueWidth = ctx.fontBold.widthOfTextAtSize(valor, FONT_SIZE);
  const gap = 10;

  if (labelWidth + gap + valueWidth <= CONTENT_WIDTH) {
    ctx.page.drawText(label, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    ctx.page.drawText(valor, {
      x: MARGIN_LEFT + CONTENT_WIDTH - valueWidth,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
    saltarLinea(ctx);
  } else {
    ctx.page.drawText(label, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    saltarLinea(ctx);
    ctx.page.drawText(valor, {
      x: MARGIN_LEFT + 20,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
    saltarLinea(ctx);
  }
}

/**
 * Writes a simple ruled table. Columns are left-aligned by default;
 * the last N columns are right-aligned when detected as numeric (starts with
 * digit, minus sign, or is empty).
 */
export function escribirTabla(
  ctx: PdfContext,
  columnas: string[],
  filas: string[][],
): void {
  const colCount = columnas.length;
  const colWidth = CONTENT_WIDTH / colCount;

  // Header row
  for (let i = 0; i < colCount; i++) {
    const isNumeric = i >= colCount - 2;
    const textWidth = ctx.fontBold.widthOfTextAtSize(columnas[i], FONT_SIZE);
    const x = isNumeric
      ? MARGIN_LEFT + colWidth * (i + 1) - textWidth - 4
      : MARGIN_LEFT + colWidth * i + 4;
    ctx.page.drawText(columnas[i], {
      x,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
  }
  saltarLinea(ctx);

  // Header underline
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y + 4 },
    end: { x: MARGIN_LEFT + CONTENT_WIDTH, y: ctx.y + 4 },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  saltarLinea(ctx, 0.5);

  // Data rows
  for (const fila of filas) {
    // Page break check
    if (ctx.y < BOTTOM_Y + LINE_HEIGHT) {
      ctx.page = ctx.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      ctx.y = TOP_Y;
    }

    for (let i = 0; i < colCount; i++) {
      const isNumeric = i >= colCount - 2;
      const cell = fila[i] ?? '';
      const textWidth = ctx.font.widthOfTextAtSize(cell, FONT_SIZE);
      const x = isNumeric
        ? MARGIN_LEFT + colWidth * (i + 1) - textWidth - 4
        : MARGIN_LEFT + colWidth * i + 4;
      ctx.page.drawText(cell, {
        x,
        y: ctx.y,
        size: FONT_SIZE,
        font: ctx.font,
        color: rgb(0, 0, 0),
      });
    }
    saltarLinea(ctx);
  }

  // Bottom rule
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y + 4 },
    end: { x: MARGIN_LEFT + CONTENT_WIDTH, y: ctx.y + 4 },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  saltarLinea(ctx);
}

/**
 * Stamps "DUPLICADO — Documento original emitido el {fecha}" diagonally
 * across the upper portion of the page. When fechaEmision is null, omits the
 * date clause, matching the old BannerDuplicado fallback.
 */
export function escribirMarcaDuplicado(
  ctx: PdfContext,
  fechaEmision: string | null,
): void {
  const texto = fechaEmision
    ? `DUPLICADO — Documento original emitido el ${new Date(fechaEmision).toLocaleDateString('es-CO')}`
    : 'DUPLICADO — Documento Original';

  ctx.page.drawText(texto, {
    x: 80,
    y: ctx.y,
    size: 18,
    font: ctx.fontBold,
    color: rgb(0.85, 0.85, 0.85),
    rotate: degrees(30),
  });
  saltarLinea(ctx, 3);
}

/**
 * Writes the copropiedad header: name, address, city, taxId, phone, email,
 * followed by a document title and optional subtitle. Text-only — Copropiedad
 * has no image/logo field.
 */
export function escribirEncabezado(
  ctx: PdfContext,
  copropiedad: CopropiedadDocument,
  titulo: string,
  subtitulo?: string,
): void {
  // Copropiedad name (bold, larger)
  ctx.page.drawText(copropiedad.name, {
    x: MARGIN_LEFT,
    y: ctx.y,
    size: HEADER_FONT_SIZE,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  saltarLinea(ctx, 1.5);

  // Address + city on one line
  const parts = [copropiedad.address, copropiedad.city].filter(Boolean);
  if (parts.length > 0) {
    escribirLinea(ctx, parts.join(', '));
  }

  // TaxId
  if (copropiedad.taxId) {
    const fullTaxId = copropiedad.taxIdVerificationDigit
      ? `NIT ${copropiedad.taxId}-${copropiedad.taxIdVerificationDigit}`
      : `NIT ${copropiedad.taxId}`;
    escribirLinea(ctx, fullTaxId);
  }

  // Phone + email on one line
  const contactParts = [copropiedad.phone, copropiedad.email].filter(Boolean);
  if (contactParts.length > 0) {
    escribirLinea(ctx, contactParts.join(' | '));
  }

  saltarLinea(ctx);

  // Document title (bold, centered)
  const titleWidth = ctx.fontBold.widthOfTextAtSize(titulo, HEADER_FONT_SIZE);
  ctx.page.drawText(titulo, {
    x: MARGIN_LEFT + (CONTENT_WIDTH - titleWidth) / 2,
    y: ctx.y,
    size: HEADER_FONT_SIZE,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  saltarLinea(ctx, 1.5);

  // Optional subtitle
  if (subtitulo) {
    const subWidth = ctx.font.widthOfTextAtSize(subtitulo, FONT_SIZE);
    ctx.page.drawText(subtitulo, {
      x: MARGIN_LEFT + (CONTENT_WIDTH - subWidth) / 2,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.font,
      color: rgb(0.3, 0.3, 0.3),
    });
    saltarLinea(ctx, 1.5);
  }
}

/** Formats a number as Colombian peso currency: $ 1.234.567 */
export function formatoPeso(valor: number): string {
  return `$ ${valor.toLocaleString('es-CO')}`;
}

/** Formats a Date as dd/mm/yyyy. */
export function formatoFecha(fecha: Date | string): string {
  return new Date(fecha).toLocaleDateString('es-CO');
}

// ── internal helpers ──

function truncateToFit(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
): string {
  let truncated = text;
  while (
    truncated.length > 0 &&
    font.widthOfTextAtSize(truncated + '…', size) > maxWidth
  ) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.length < text.length ? truncated + '…' : truncated;
}
