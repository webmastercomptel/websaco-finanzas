import { type PDFPage, rgb } from 'pdf-lib';
import { crearContexto, formatoFecha, truncateToFit } from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  RangoVencimiento,
  RespuestaVencimientosCartera,
} from '../../contracts';

const MARGIN = 50;
const ALTO_FILA = 12;
const MARGIN_PIE = 30;

const RANGOS: { rango: RangoVencimiento; etiqueta: string }[] = [
  { rango: 'sinVencer', etiqueta: 'Sin Vencer' },
  { rango: 'dias_1_30', etiqueta: '1-30' },
  { rango: 'dias_31_60', etiqueta: '31-60' },
  { rango: 'dias_61_90', etiqueta: '61-90' },
  { rango: 'dias_91_120', etiqueta: '91-120' },
  { rango: 'dias_121_180', etiqueta: '121-180' },
  { rango: 'dias_181_360', etiqueta: '181-360' },
  { rango: 'dias_361_720', etiqueta: '361-720' },
  { rango: 'dias_720_mas', etiqueta: '+720' },
];

interface ColumnaTabla {
  titulo: string;
  peso: number;
  numerica: boolean;
}

const COLUMNAS: ColumnaTabla[] = [
  { titulo: 'Código', peso: 0.9, numerica: false },
  { titulo: 'Nombre', peso: 1.6, numerica: false },
  { titulo: 'Tipo', peso: 0.6, numerica: false },
  { titulo: 'Número', peso: 1.2, numerica: false },
  { titulo: 'Fecha', peso: 0.9, numerica: false },
  { titulo: 'Vence', peso: 0.9, numerica: false },
  { titulo: 'Días', peso: 0.6, numerica: true },
  { titulo: 'Saldo', peso: 1.1, numerica: true },
  ...RANGOS.map((r) => ({ titulo: r.etiqueta, peso: 1, numerica: true })),
];

function formatoPesoCompacto(valor: number): string {
  return valor.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

/** Narrows `reporte` to one inmueble and/or one aging bucket — the same
 *  on-screen filters `vencimientos-cartera.tsx` applies client-side, mirrored
 *  here so the PDF (rendered server-side, unlike the Excel export) reflects
 *  whichever filters were active instead of always printing everything. */
function filtrarReporte(
  reporte: RespuestaVencimientosCartera,
  filtro: { inmuebleId?: string; rango?: RangoVencimiento },
): RespuestaVencimientosCartera {
  if (!filtro.inmuebleId && !filtro.rango) return reporte;

  const filas = reporte.filas.filter(
    (f) =>
      (!filtro.inmuebleId || f.inmuebleId === filtro.inmuebleId) &&
      (!filtro.rango || f.rango === filtro.rango),
  );
  const rangos = RANGOS.map((r) => ({
    rango: r.rango,
    etiqueta:
      reporte.rangos.find((existente) => existente.rango === r.rango)
        ?.etiqueta ?? r.etiqueta,
    valor: filas
      .filter((f) => f.rango === r.rango)
      .reduce((sum, f) => sum + f.saldo, 0),
  }));
  const totalCartera = filas.reduce((sum, f) => sum + f.saldo, 0);

  return { ...reporte, filas, rangos, totalCartera };
}

/**
 * Generates a real PDF for Vencimientos de Cartera: every pending document
 * coproperty-wide, aged into its own column — 17 columns total (8 fixed +
 * 9 aging buckets, all fixed, never per-coproperty dynamic), wide enough
 * that this manages its own landscape pagination with a repeating header
 * and a shrunk font, the same approach `consulta-facturacion-pdf.ts` uses
 * for its own wide, dynamic-column table. `filtro` narrows to one inmueble
 * and/or one aging bucket, matching whatever's active on screen.
 */
export async function generarPdfVencimientosCartera(
  reporteCompleto: RespuestaVencimientosCartera,
  copropiedad: CopropiedadDocument,
  filtro: { inmuebleId?: string; rango?: RangoVencimiento } = {},
): Promise<Uint8Array> {
  const reporte = filtrarReporte(reporteCompleto, filtro);
  const ctx = await crearContexto({ orientacion: 'horizontal' });

  const pesoTotal = COLUMNAS.reduce((acc, c) => acc + c.peso, 0);
  const anchos = COLUMNAS.map((c) => (c.peso / pesoTotal) * ctx.contentWidth);
  // 17 columns need a small font to all fit — no truncation-worthy content
  // is expected at this size (codes/numbers are short), "Nombre" gets
  // truncated defensively via `truncateToFit` regardless.
  const fuenteDatos = 6.5;
  const fuenteTitulo = 7;

  const subtitulo = `Análisis de Vencimientos — Corte al ${formatoFecha(reporte.fechaCorte)}`;
  const paginas: PDFPage[] = [];

  const dibujarEncabezado = (page: PDFPage): number => {
    let y = ctx.pageHeight - 34;
    page.drawText(copropiedad.name, {
      x: MARGIN,
      y,
      size: 12,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
    y -= 16;
    page.drawText(subtitulo, {
      x: MARGIN,
      y,
      size: fuenteTitulo + 3,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
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
        height: ALTO_FILA + 3,
        color: rgb(0.92, 0.92, 0.92),
      });
    }
    let x = MARGIN;
    celdas.forEach((celda, i) => {
      const ancho = anchos[i];
      const texto =
        font.widthOfTextAtSize(celda, fuenteDatos) > ancho - 4
          ? truncateToFit(font, celda, fuenteDatos, ancho - 4)
          : celda;
      const textWidth = font.widthOfTextAtSize(texto, fuenteDatos);
      const cellX = COLUMNAS[i].numerica ? x + ancho - textWidth - 3 : x + 3;
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
      COLUMNAS.map((c) => c.titulo),
      { bold: true, fondo: true },
    );
    page.drawLine({
      start: { x: MARGIN, y: y - 4 },
      end: { x: MARGIN + ctx.contentWidth, y: y - 4 },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    return y - ALTO_FILA - 5;
  };

  let primeraPagina = true;
  const nuevaPagina = (): { page: PDFPage; y: number } => {
    const page = primeraPagina
      ? ctx.page
      : ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
    primeraPagina = false;
    paginas.push(page);
    const yTrasEncabezado = dibujarEncabezado(page);
    return { page, y: dibujarEncabezadoTabla(page, yTrasEncabezado) };
  };

  let { page, y } = nuevaPagina();

  for (const f of reporte.filas) {
    if (y < MARGIN_PIE + ALTO_FILA) {
      ({ page, y } = nuevaPagina());
    }
    const celdas = [
      f.inmuebleCodigo,
      f.propietario ?? '—',
      f.tipo,
      f.numeroCompleto,
      formatoFecha(f.fecha),
      formatoFecha(f.vence),
      String(f.diasMora),
      formatoPesoCompacto(f.saldo),
      ...RANGOS.map((r) =>
        f.rango === r.rango ? formatoPesoCompacto(f.saldo) : '',
      ),
    ];
    dibujarFila(page, y, celdas);
    y -= ALTO_FILA;
  }

  if (y < MARGIN_PIE + ALTO_FILA) {
    ({ page, y } = nuevaPagina());
  }
  const totalPorRango = new Map(reporte.rangos.map((r) => [r.rango, r.valor]));
  dibujarFila(
    page,
    y,
    [
      'TOTAL',
      '',
      '',
      '',
      '',
      '',
      '',
      formatoPesoCompacto(reporte.totalCartera),
      ...RANGOS.map((r) =>
        formatoPesoCompacto(totalPorRango.get(r.rango) ?? 0),
      ),
    ],
    { bold: true, fondo: true },
  );

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
