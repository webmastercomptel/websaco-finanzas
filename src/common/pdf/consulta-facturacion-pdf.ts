import { type PDFPage, rgb } from 'pdf-lib';
import {
  crearContexto,
  embebirLogoWebsaco,
  formatoFecha,
  truncateToFit,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaConsultaFacturacion } from '../../contracts';

const MARGIN = 50;
/** Up to 11 concepts get their own column; anything beyond that is summed
 *  into one final "Otros Cargos" column — per product decision, a
 *  coproperty with 11 concepts or fewer never shows that grouped column at
 *  all (see `construirColumnas`). */
const MAX_CARGOS_INDIVIDUALES = 11;
const FONT_TITULO = 8;
const FONT_DATA = 7;
const ALTO_FILA = 13;
const ALTO_ENCABEZADO_TABLA = 16;
/** Reserved at the bottom of every page for the "Página x/xxx" footer. */
const MARGIN_PIE = 30;

/** Same grouping-thousands format as `formatoPeso`, minus the "$ " prefix —
 *  this table is dense enough (up to sixteen columns) that the symbol on
 *  every cell would cost more width than it's worth; the "Total Factura"
 *  column header already says these are money. */
function formatoPesoCompacto(valor: number): string {
  return valor.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

function formatoHora(fecha: Date): string {
  return fecha.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'America/Bogota',
  });
}

interface ColumnaTabla {
  titulo: string;
  /** Relative weight, not points — normalized against `ctx.contentWidth`
   *  once the full column set (fixed to `4 + hasta 12` de dinámicas) is
   *  known, so the table always fills the page regardless of how many
   *  concept columns a coproperty ends up with. */
  peso: number;
  numerica: boolean;
}

/** Builds the fixed identifying columns (No. Factura/Inmueble/Fecha/Total)
 *  plus up to eleven per-concept columns, plus a twelfth "Otros Cargos"
 *  column ONLY when the coproperty has more than eleven concepts — the
 *  dynamic layout the product owner asked for: never a fixed twelve-slot
 *  table, but never more than twelve concept-related columns either. */
function construirColumnas(reporte: RespuestaConsultaFacturacion): {
  columnas: ColumnaTabla[];
  conceptosIndividuales: RespuestaConsultaFacturacion['totalesPorConcepto'];
  conceptosAgrupados: RespuestaConsultaFacturacion['totalesPorConcepto'];
} {
  const conceptosIndividuales = reporte.totalesPorConcepto.slice(
    0,
    MAX_CARGOS_INDIVIDUALES,
  );
  const conceptosAgrupados = reporte.totalesPorConcepto.slice(
    MAX_CARGOS_INDIVIDUALES,
  );

  const columnas: ColumnaTabla[] = [
    { titulo: 'No. Factura', peso: 1.5, numerica: false },
    { titulo: 'Inmueble', peso: 1, numerica: false },
    { titulo: 'Fecha', peso: 0.9, numerica: false },
    { titulo: 'Total Factura', peso: 1.3, numerica: true },
    ...conceptosIndividuales.map((c) => ({
      titulo: c.nombreConcepto,
      peso: 1.15,
      numerica: true,
    })),
    ...(conceptosAgrupados.length > 0
      ? [{ titulo: 'Otros Cargos', peso: 1.15, numerica: true }]
      : []),
  ];

  return { columnas, conceptosIndividuales, conceptosAgrupados };
}

/**
 * Generates the "Consulta de Facturación" report PDF: a single unified,
 * landscape table — one row per Factura of the lote, columns No. Factura /
 * Inmueble / Fecha / Total Factura, then up to eleven individual concept
 * columns and (only when the coproperty has more than eleven concepts) one
 * final "Otros Cargos" column summing the rest. A two-line masthead
 * (coproperty name + generation timestamp; report title + billing period +
 * the small WebSACO logo) and a "Página x/xxx" footer repeat on every page —
 * modeled after the predecessor system's own printed listing (see the
 * product brief's reference PDF), adapted for a dynamic concept count
 * instead of the predecessor's hardcoded twelve.
 *
 * Unlike every other PDF builder in this module, this one manages its own
 * pagination instead of relying on `pdf-helpers`' `escribirTabla`/
 * `saltarLinea`: the masthead must redraw on every new page (including ones
 * `pdf-helpers` would add automatically mid-table) and the footer needs the
 * final page count, known only once every row is placed — neither fits
 * `pdf-helpers`' single-pass, no-callback drawing model.
 */
export async function generarPdfConsultaFacturacion(
  reporte: RespuestaConsultaFacturacion,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const ctx = await crearContexto({ orientacion: 'horizontal' });
  const {
    image: logo,
    width: logoWidth,
    height: logoHeight,
  } = await embebirLogoWebsaco(ctx.doc);
  const generadoEl = new Date();

  const { columnas, conceptosIndividuales, conceptosAgrupados } =
    construirColumnas(reporte);
  const pesoTotal = columnas.reduce((acc, c) => acc + c.peso, 0);
  const anchos = columnas.map((c) => (c.peso / pesoTotal) * ctx.contentWidth);

  // Shrinks the data font as column count grows, down to a 5.5pt floor —
  // "ajustar para esto el tamaño de la fuente" (product brief): a
  // coproperty near the twelve-column ceiling needs smaller text to keep
  // every cell legible without truncating currency amounts.
  const fuenteDatos = Math.max(
    5.5,
    FONT_DATA - Math.max(0, columnas.length - 10) * 0.3,
  );
  const fuenteTitulo = Math.max(
    6,
    FONT_TITULO - Math.max(0, columnas.length - 10) * 0.2,
  );

  const subtitulo = `Listado de Facturación al día ${formatoFecha(reporte.fechaFacturacion)} — Período: ${formatoFecha(reporte.fechaFacturacion)} a ${formatoFecha(reporte.fechaVencimiento)}`;

  const paginas: PDFPage[] = [];

  /** Draws the two-line masthead on `page` and returns the y coordinate
   *  where page content (the table) may start. Called once per page,
   *  including every page a mid-table break adds — so the header is
   *  identical on every page, exactly as the product brief asked
   *  ("esto se debe repetir en todo en cada pagina"). */
  const dibujarEncabezado = (page: PDFPage): number => {
    let y = ctx.pageHeight - 34;

    page.drawText(copropiedad.name, {
      x: MARGIN,
      y,
      size: 12,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
    const generadoTexto = `Generado: ${formatoFecha(generadoEl)} ${formatoHora(generadoEl)}`;
    const generadoAncho = ctx.font.widthOfTextAtSize(generadoTexto, 8);
    page.drawText(generadoTexto, {
      x: MARGIN + ctx.contentWidth - generadoAncho,
      y: y + 1,
      size: 8,
      font: ctx.font,
      color: rgb(0.3, 0.3, 0.3),
    });

    y -= 16;
    const tituloAncho = ctx.fontBold.widthOfTextAtSize(subtitulo, fuenteTitulo);
    const tituloMostrado =
      tituloAncho > ctx.contentWidth - logoWidth - 10
        ? truncateToFit(
            ctx.fontBold,
            subtitulo,
            fuenteTitulo,
            ctx.contentWidth - logoWidth - 10,
          )
        : subtitulo;
    page.drawText(tituloMostrado, {
      x: MARGIN,
      y,
      size: fuenteTitulo,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
    page.drawImage(logo, {
      x: MARGIN + ctx.contentWidth - logoWidth,
      y: y - logoHeight + 8,
      width: logoWidth,
      height: logoHeight,
    });

    y -= 14;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + ctx.contentWidth, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= 12;

    return y;
  };

  /** Draws one row of fixed-width cells at the current `y`, right-aligning
   *  numeric columns — same convention every other PDF builder in this
   *  module uses. */
  const dibujarFila = (
    page: PDFPage,
    y: number,
    celdas: string[],
    opciones?: { bold?: boolean; fondo?: boolean },
  ): void => {
    const font = opciones?.bold ? ctx.fontBold : ctx.font;
    if (opciones?.fondo) {
      page.drawRectangle({
        x: MARGIN,
        y: y - 3,
        width: ctx.contentWidth,
        height: ALTO_FILA,
        color: rgb(0.92, 0.92, 0.92),
      });
    }
    let x = MARGIN;
    celdas.forEach((celda, i) => {
      const ancho = anchos[i];
      const texto =
        font.widthOfTextAtSize(celda, fuenteDatos) > ancho - 6
          ? truncateToFit(font, celda, fuenteDatos, ancho - 6)
          : celda;
      const textWidth = font.widthOfTextAtSize(texto, fuenteDatos);
      const cellX = columnas[i].numerica ? x + ancho - textWidth - 4 : x + 4;
      page.drawText(texto, {
        x: cellX,
        y,
        size: fuenteDatos,
        font,
        color: rgb(0, 0, 0),
      });
      x += ancho;
    });
  };

  const dibujarEncabezadoTabla = (page: PDFPage, y: number): number => {
    dibujarFila(
      page,
      y,
      columnas.map((c) => c.titulo),
      { bold: true, fondo: true },
    );
    page.drawLine({
      start: { x: MARGIN, y: y - 4 },
      end: { x: MARGIN + ctx.contentWidth, y: y - 4 },
      thickness: 0.75,
      color: rgb(0, 0, 0),
    });
    return y - ALTO_ENCABEZADO_TABLA;
  };

  // `crearContexto` already created a first page (`ctx.page`) — reuse it
  // for the FIRST call instead of always calling `addPage`, or that page
  // stays in the document completely blank (nothing ever drew on it) while
  // every real page shifts one number later — the blank first page reported.
  let primeraPagina = true;
  const nuevaPagina = (): { page: PDFPage; y: number } => {
    const page = primeraPagina
      ? ctx.page
      : ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
    primeraPagina = false;
    paginas.push(page);
    const yTrasEncabezado = dibujarEncabezado(page);
    const yTrasTitulo = yTrasEncabezado;
    return { page, y: dibujarEncabezadoTabla(page, yTrasTitulo) };
  };

  let { page, y } = nuevaPagina();

  for (const f of reporte.filas) {
    if (y < MARGIN_PIE + ALTO_FILA) {
      ({ page, y } = nuevaPagina());
    }

    const otrosCargos = conceptosAgrupados.reduce(
      (acc, c) => acc + (f.valoresPorConcepto[c.conceptoId] ?? 0),
      0,
    );
    const celdas = [
      f.numeroCompleto,
      f.inmuebleCodigo,
      formatoFecha(f.fechaFactura),
      formatoPesoCompacto(f.total),
      ...conceptosIndividuales.map((c) =>
        formatoPesoCompacto(f.valoresPorConcepto[c.conceptoId] ?? 0),
      ),
      ...(conceptosAgrupados.length > 0
        ? [formatoPesoCompacto(otrosCargos)]
        : []),
    ];
    dibujarFila(page, y, celdas);
    y -= ALTO_FILA;
  }

  if (y < MARGIN_PIE + ALTO_FILA) {
    ({ page, y } = nuevaPagina());
  }
  const totalOtrosCargos = reporte.filas.reduce(
    (acc, f) =>
      acc +
      conceptosAgrupados.reduce(
        (a, c) => a + (f.valoresPorConcepto[c.conceptoId] ?? 0),
        0,
      ),
    0,
  );
  const celdasTotales = [
    'TOTALES',
    '',
    '',
    formatoPesoCompacto(reporte.total),
    ...conceptosIndividuales.map((c) => formatoPesoCompacto(c.monto)),
    ...(conceptosAgrupados.length > 0
      ? [formatoPesoCompacto(totalOtrosCargos)]
      : []),
  ];
  dibujarFila(page, y, celdasTotales, { bold: true, fondo: true });

  // ── Footer: "Página x/xxx", bottom-right of every page — only knowable
  // now that every page has been created. ──
  const totalPaginas = paginas.length;
  paginas.forEach((p, i) => {
    const texto = `Página ${i + 1}/${totalPaginas}`;
    const ancho = ctx.font.widthOfTextAtSize(texto, 8);
    p.drawText(texto, {
      x: MARGIN + ctx.contentWidth - ancho,
      y: MARGIN_PIE - 16,
      size: 8,
      font: ctx.font,
      color: rgb(0.3, 0.3, 0.3),
    });
  });

  return ctx.doc.save();
}
