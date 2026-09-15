import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PDFDocument,
  PDFPage,
  PDFFont,
  PDFImage,
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
  /** Page dimensions for this context — Letter portrait unless `crearContexto`
   *  was asked for `orientacion: 'horizontal'`. Every write helper reads
   *  these instead of a hardcoded Letter-portrait constant, so a landscape
   *  report (e.g. a wide table with many columns) lays out correctly. */
  pageWidth: number;
  pageHeight: number;
  contentWidth: number;
}

const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const PAGE_WIDTH = 612; // Letter portrait
const PAGE_HEIGHT = 792;
const TOP_MARGIN = 50;
const BOTTOM_MARGIN = 50;
const LINE_HEIGHT = 14;
const FONT_SIZE = 10;
const HEADER_FONT_SIZE = 14;

/**
 * Creates a fresh PdfContext on a single page with Helvetica embedded.
 * No filesystem writes — the PDF lives entirely in memory until saved.
 * Defaults to Letter portrait; pass `orientacion: 'horizontal'` for a wide
 * report (Letter landscape) instead.
 */
export async function crearContexto(opciones?: {
  orientacion?: 'vertical' | 'horizontal';
}): Promise<PdfContext> {
  const horizontal = opciones?.orientacion === 'horizontal';
  const pageWidth = horizontal ? PAGE_HEIGHT : PAGE_WIDTH;
  const pageHeight = horizontal ? PAGE_WIDTH : PAGE_HEIGHT;
  const contentWidth = pageWidth - MARGIN_LEFT - MARGIN_RIGHT;

  const doc = await PDFDocument.create();
  const page = doc.addPage([pageWidth, pageHeight]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  return {
    doc,
    page,
    font,
    fontBold,
    y: pageHeight - TOP_MARGIN,
    pageWidth,
    pageHeight,
    contentWidth,
  };
}

/** Advances y to the next line. Adds a new page when the cursor reaches the bottom. */
function saltarLinea(ctx: PdfContext, veces = 1): void {
  ctx.y -= LINE_HEIGHT * veces;
  if (ctx.y < BOTTOM_MARGIN) {
    ctx.page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
    ctx.y = ctx.pageHeight - TOP_MARGIN;
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
    font.widthOfTextAtSize(texto, size) > ctx.contentWidth
      ? truncateToFit(font, texto, size, ctx.contentWidth)
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

  if (labelWidth + gap + valueWidth <= ctx.contentWidth) {
    ctx.page.drawText(label, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    ctx.page.drawText(valor, {
      x: MARGIN_LEFT + ctx.contentWidth - valueWidth,
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
 * the last `columnasNumericas` columns are right-aligned (default 2, the
 * original "last 2 columns are numeric" heuristic — every existing caller
 * omits the option and sees no behavior change).
 *
 * `colorLineas`/`grosorLineas` restyle the header underline and bottom rule
 * (default black/0.5, unchanged for every caller that omits them);
 * `espacioAntesDatos` widens the gap between the header underline and the
 * first data row (default 0.5 line, unchanged unless passed) — Factura uses
 * both to match its own header-line styling.
 *
 * `anchosRelativos` gives each column its own weight instead of the default
 * equal split — needed when one column (a "Concepto" label, say) genuinely
 * needs more room than a short numeric one; every caller that omits it still
 * gets equal-width columns, unchanged. Data cells are still drawn without
 * truncation (same as before this option existed) — a caller with long
 * content must size its columns wide enough via this, not rely on wrapping.
 */
export function escribirTabla(
  ctx: PdfContext,
  columnas: string[],
  filas: string[][],
  opciones?: {
    columnasNumericas?: number;
    colorLineas?: ReturnType<typeof rgb>;
    grosorLineas?: number;
    espacioAntesDatos?: number;
    anchosRelativos?: number[];
  },
): void {
  const colCount = columnas.length;
  const pesos = opciones?.anchosRelativos ?? columnas.map(() => 1);
  const pesoTotal = pesos.reduce((acc, p) => acc + p, 0);
  const anchos = pesos.map((p) => (p / pesoTotal) * ctx.contentWidth);
  const xInicioCol = (i: number): number =>
    MARGIN_LEFT + anchos.slice(0, i).reduce((acc, a) => acc + a, 0);
  const primeraNumerica = colCount - (opciones?.columnasNumericas ?? 2);
  const colorLineas = opciones?.colorLineas ?? rgb(0, 0, 0);
  const grosorLineas = opciones?.grosorLineas ?? 0.5;

  // Header row
  for (let i = 0; i < colCount; i++) {
    const isNumeric = i >= primeraNumerica;
    const textWidth = ctx.fontBold.widthOfTextAtSize(columnas[i], FONT_SIZE);
    const x = isNumeric
      ? xInicioCol(i) + anchos[i] - textWidth - 4
      : xInicioCol(i) + 4;
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
    end: { x: MARGIN_LEFT + ctx.contentWidth, y: ctx.y + 4 },
    thickness: grosorLineas,
    color: colorLineas,
  });
  saltarLinea(ctx, opciones?.espacioAntesDatos ?? 0.5);

  // Data rows
  for (const fila of filas) {
    // Page break check
    if (ctx.y < BOTTOM_MARGIN + LINE_HEIGHT) {
      ctx.page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
      ctx.y = ctx.pageHeight - TOP_MARGIN;
    }

    for (let i = 0; i < colCount; i++) {
      const isNumeric = i >= primeraNumerica;
      const cell = fila[i] ?? '';
      const textWidth = ctx.font.widthOfTextAtSize(cell, FONT_SIZE);
      const x = isNumeric
        ? xInicioCol(i) + anchos[i] - textWidth - 4
        : xInicioCol(i) + 4;
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
    end: { x: MARGIN_LEFT + ctx.contentWidth, y: ctx.y + 4 },
    thickness: grosorLineas,
    color: colorLineas,
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
    ? `DUPLICADO — Documento original emitido el ${new Date(fechaEmision).toLocaleDateString('es-CO', { timeZone: 'UTC' })}`
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
    x: MARGIN_LEFT + (ctx.contentWidth - titleWidth) / 2,
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
      x: MARGIN_LEFT + (ctx.contentWidth - subWidth) / 2,
      y: ctx.y,
      size: FONT_SIZE,
      font: ctx.font,
      color: rgb(0.3, 0.3, 0.3),
    });
    saltarLinea(ctx, 1.5);
  }
}

const GRIS_CLARO = rgb(0.9, 0.9, 0.9);

/**
 * Gray banner header shared by every "printed form" document (Recibo, Nota
 * Crédito, Auxiliar de Cartera, …): the copropiedad name and logo in a gray
 * banner, NIT on the left and the document title — with an optional
 * document number beside it — right-aligned, then a thin gray rule below.
 * Originally Recibo/Nota Crédito's own private `dibujarEncabezadoRecibo`;
 * extracted so Auxiliar de Cartera's print could reuse the identical
 * masthead instead of `escribirEncabezado`'s plain text-only header.
 * `numeroCompleto` omitted (or empty) prints the title alone — a report
 * like Auxiliar de Cartera has no document number of its own.
 */
export async function dibujarEncabezadoDocumento(
  ctx: PdfContext,
  copropiedad: CopropiedadDocument,
  tituloDocumento: string,
  numeroCompleto?: string,
): Promise<void> {
  const bannerAltura = 26;
  const bannerTop = ctx.y + 8;
  const bannerBottom = bannerTop - bannerAltura;
  ctx.page.drawRectangle({
    x: 0,
    y: ctx.y - bannerAltura + 8,
    width: ctx.pageWidth,
    height: bannerAltura,
    color: GRIS_CLARO,
  });
  ctx.page.drawText(copropiedad.name, {
    x: MARGIN_LEFT,
    y: ctx.y - 10,
    size: 16,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  const {
    image: logo,
    width: logoWidth,
    height: logoHeight,
  } = await embebirLogoWebsaco(ctx.doc);
  ctx.page.drawImage(logo, {
    x: MARGIN_LEFT + ctx.contentWidth - logoWidth,
    y: (bannerTop + bannerBottom) / 2 - logoHeight / 2,
    width: logoWidth,
    height: logoHeight,
  });

  ctx.y -= bannerAltura + 6;

  const filaTitulo = ctx.y;
  const nit = copropiedad.taxId
    ? copropiedad.taxIdVerificationDigit
      ? `${copropiedad.taxId}-${copropiedad.taxIdVerificationDigit}`
      : copropiedad.taxId
    : '—';
  ctx.page.drawText('NIT :', {
    x: MARGIN_LEFT,
    y: filaTitulo,
    size: 9,
    font: ctx.font,
    color: rgb(0.3, 0.3, 0.3),
  });
  ctx.page.drawText(nit, {
    x: MARGIN_LEFT + 35,
    y: filaTitulo,
    size: 9,
    font: ctx.font,
    color: rgb(0, 0, 0),
  });

  const titulo = numeroCompleto
    ? `${tituloDocumento} ${numeroCompleto}`
    : tituloDocumento;
  const tituloAncho = ctx.fontBold.widthOfTextAtSize(titulo, 13);
  ctx.page.drawText(titulo, {
    x: MARGIN_LEFT + ctx.contentWidth - tituloAncho,
    y: filaTitulo,
    size: 13,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  ctx.y -= 10;
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y },
    end: { x: MARGIN_LEFT + ctx.contentWidth, y: ctx.y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  // One blank line below the rule before the caller's own info block starts
  // — the block used to start right against it.
  ctx.y -= 14 + 15;
}

/** "Muy pequeñito" per spec — the logo is a corner mark, not a masthead.
 *  Every document that shows the WebSACO logo (Estado de Cuenta, Factura,
 *  Prefactura) draws it at this same width, aspect ratio preserved. */
export const LOGO_WIDTH = 50;

let logoBytesCache: Buffer | null = null;

/** Lazily reads and caches the WebSACO logo PNG from the shared static-assets
 *  folder (copied into `dist/` by nest-cli.json's `assets` config) — read
 *  once per process, not once per PDF. */
function cargarLogoBytes(): Buffer {
  logoBytesCache ??= readFileSync(
    join(__dirname, '../assets/websaco-logo.png'),
  );
  return logoBytesCache;
}

/**
 * Embeds the WebSACO logo into `doc` at the shared `LOGO_WIDTH`, aspect
 * ratio preserved. Each caller still positions it — headers differ too much
 * (Factura's own layout vs. the shared gray-banner masthead
 * `dibujarEncabezadoDocumento` uses) to share a single draw call, but the
 * size and the asset must stay identical.
 */
export async function embebirLogoWebsaco(doc: PDFDocument): Promise<{
  image: PDFImage;
  width: number;
  height: number;
}> {
  const image = await doc.embedPng(cargarLogoBytes());
  const height = image.height * (LOGO_WIDTH / image.width);
  return { image, width: LOGO_WIDTH, height };
}

/** Formats a number as Colombian peso currency: $ 1.234.567 — thousands
 *  separated by ".", never a decimal (`maximumFractionDigits: 0` pinned
 *  explicitly rather than left to the locale default, so a float-rounding
 *  artifact upstream can never sneak stray cents onto a printed document). */
export function formatoPeso(valor: number): string {
  return `$ ${valor.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}

const FORMATO_FECHA = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Formats a Date as dd/mm/yyyy, day and month always 2 digits (`05/01/2026`,
 *  never `5/1/2026`) — `Date#toLocaleDateString` doesn't zero-pad, which
 *  ragged a column of stacked dates whenever one had a single-digit day/month.
 *  Pinned to UTC — every date-only business date this app stores is midnight
 *  UTC to begin with (see the note in frontend's lote-definicion.tsx), so
 *  formatting in the server's local timezone would show the day before
 *  whenever that offset is negative (e.g. Cloud Run running in
 *  America/Bogota, UTC-5). */
export function formatoFecha(fecha: Date | string): string {
  return FORMATO_FECHA.format(new Date(fecha));
}

// ── internal helpers ──

/** Exported for the odd builder that needs per-cell truncation of its own
 *  (fixed-width table columns, e.g.) rather than whole-line truncation. */
export function truncateToFit(
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
