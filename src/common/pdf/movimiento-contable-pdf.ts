import { type PDFPage, rgb } from 'pdf-lib';
import { crearContexto, formatoFecha, truncateToFit } from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaMovimientoContable } from '../../contracts';

const MARGIN = 50;
const ALTO_FILA = 12;
const MARGIN_PIE = 30;

interface ColumnaTabla {
  titulo: string;
  peso: number;
  numerica: boolean;
}

const COLUMNAS: ColumnaTabla[] = [
  { titulo: 'Tipo', peso: 0.5, numerica: false },
  { titulo: 'Número', peso: 1.1, numerica: false },
  { titulo: 'Código', peso: 0.7, numerica: false },
  { titulo: 'Nombre de la Cuenta', peso: 1.9, numerica: false },
  { titulo: 'Inmueble', peso: 0.8, numerica: false },
  { titulo: 'Fecha', peso: 0.9, numerica: false },
  { titulo: 'Débito', peso: 1.0, numerica: true },
  { titulo: 'Crédito', peso: 1.0, numerica: true },
  { titulo: 'Tercero', peso: 1.0, numerica: false },
  { titulo: 'Centro Costo', peso: 1.0, numerica: false },
  { titulo: 'Flujo Caja', peso: 1.0, numerica: false },
  { titulo: 'Base Gravable', peso: 1.0, numerica: true },
];

function formatoPesoCompacto(valor: number): string {
  return valor.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

/** One flattened accounting line — mirrors the frontend's own `FilaLinea` in
 *  `movimiento-contable.tsx`: the printed table needs the same tipo/número
 *  ascending order and per-document subtotal bar the screen shows, not the
 *  movimientos-grouped shape `RespuestaMovimientoContable` returns. */
interface FilaLinea {
  tipoDocumento: string;
  numeroDocumento: string;
  cuenta: string;
  nombreCuenta: string;
  inmuebleCodigo: string | null;
  fecha: string;
  debito: number | null;
  credito: number | null;
  tercero: string | null;
  centroCosto: string | null;
  flujoCaja: string | null;
  baseGravable: number | null;
}

/** Same ascending tipo-then-número ordering the on-screen table uses
 *  (`compararPorTipoYNumero` in `movimiento-contable.tsx`) — `numeric: true`
 *  compares "RC-10" after "RC-9", not before as a plain string compare
 *  would. `sort` is stable, so lines already grouped by document stay
 *  grouped after this. */
const collator = new Intl.Collator('es', {
  numeric: true,
  sensitivity: 'base',
});
function compararPorTipoYNumero(a: FilaLinea, b: FilaLinea): number {
  return (
    collator.compare(a.tipoDocumento, b.tipoDocumento) ||
    collator.compare(a.numeroDocumento, b.numeroDocumento)
  );
}

function aFilas(reporte: RespuestaMovimientoContable): FilaLinea[] {
  const filas: FilaLinea[] = [];
  for (const m of reporte.movimientos) {
    for (const l of m.lineas) {
      filas.push({
        tipoDocumento: m.tipoDocumento,
        numeroDocumento: m.numeroDocumento,
        cuenta: l.cuenta,
        nombreCuenta: l.nombreCuenta,
        inmuebleCodigo: m.inmuebleCodigo,
        fecha: m.fecha,
        debito: l.tipo === 'debito' ? l.monto : null,
        credito: l.tipo === 'credito' ? l.monto : null,
        tercero: l.tercero,
        centroCosto: l.centroCosto,
        flujoCaja: l.flujoCaja,
        baseGravable: l.baseGravable,
      });
    }
  }
  return filas.sort(compararPorTipoYNumero);
}

/**
 * Generates a real PDF for Consulta de Movimiento Contable: the coproperty's
 * full accounting ledger for a date range, flattened to one row per line and
 * closing each document with its own subtotal bar — 12 columns, wide enough
 * that (like `vencimientos-cartera-pdf.ts`) this manages its own landscape
 * pagination with a repeating header and a shrunk font.
 */
export async function generarPdfMovimientoContable(
  reporte: RespuestaMovimientoContable,
  copropiedad: CopropiedadDocument,
  desde: string,
  hasta: string,
): Promise<Uint8Array> {
  const ctx = await crearContexto({ orientacion: 'horizontal' });

  const pesoTotal = COLUMNAS.reduce((acc, c) => acc + c.peso, 0);
  const anchos = COLUMNAS.map((c) => (c.peso / pesoTotal) * ctx.contentWidth);
  // 12 columns still need a small font to all fit comfortably alongside
  // free-text ones ("Nombre de la Cuenta", "Tercero") — same approach
  // `vencimientos-cartera-pdf.ts` uses for its own wide table.
  const fuenteDatos = 6.5;
  const fuenteTitulo = 7;

  const subtitulo = `Movimiento Contable — ${formatoFecha(desde)} al ${formatoFecha(hasta)}`;
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

  const filas = aFilas(reporte);
  let totalDebitoGeneral = 0;
  let totalCreditoGeneral = 0;

  const filaSubtotal = (debito: number, credito: number): string[] => [
    '',
    '',
    '',
    'Total',
    '',
    '',
    formatoPesoCompacto(debito),
    formatoPesoCompacto(credito),
    '',
    '',
    '',
    '',
  ];

  filas.forEach((f, i) => {
    if (y < MARGIN_PIE + ALTO_FILA) {
      ({ page, y } = nuevaPagina());
    }
    dibujarFila(page, y, [
      f.tipoDocumento,
      f.numeroDocumento,
      f.cuenta,
      f.nombreCuenta,
      f.inmuebleCodigo ?? '—',
      formatoFecha(f.fecha),
      f.debito != null ? formatoPesoCompacto(f.debito) : '',
      f.credito != null ? formatoPesoCompacto(f.credito) : '',
      f.tercero ?? '—',
      f.centroCosto ?? '—',
      f.flujoCaja ?? '—',
      f.baseGravable != null ? formatoPesoCompacto(f.baseGravable) : '—',
    ]);
    y -= ALTO_FILA;
    totalDebitoGeneral += f.debito ?? 0;
    totalCreditoGeneral += f.credito ?? 0;

    const siguiente = filas[i + 1];
    const esUltimaDelDocumento =
      !siguiente ||
      siguiente.tipoDocumento !== f.tipoDocumento ||
      siguiente.numeroDocumento !== f.numeroDocumento;
    if (esUltimaDelDocumento) {
      const delDocumento = filas.filter(
        (x) =>
          x.tipoDocumento === f.tipoDocumento &&
          x.numeroDocumento === f.numeroDocumento,
      );
      const debitoDoc = delDocumento.reduce((s, x) => s + (x.debito ?? 0), 0);
      const creditoDoc = delDocumento.reduce((s, x) => s + (x.credito ?? 0), 0);
      if (y < MARGIN_PIE + ALTO_FILA) {
        ({ page, y } = nuevaPagina());
      }
      dibujarFila(page, y, filaSubtotal(debitoDoc, creditoDoc), {
        bold: true,
        fondo: true,
      });
      y -= ALTO_FILA;
    }
  });

  if (filas.length === 0) {
    if (y < MARGIN_PIE + ALTO_FILA) {
      ({ page, y } = nuevaPagina());
    }
    const mensaje = truncateToFit(
      ctx.font,
      'No hay transacciones contables en el período seleccionado',
      fuenteDatos + 2,
      ctx.contentWidth - 8,
    );
    page.drawText(mensaje, {
      x: MARGIN + 4,
      y,
      size: fuenteDatos + 2,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
  } else {
    if (y < MARGIN_PIE + ALTO_FILA) {
      ({ page, y } = nuevaPagina());
    }
    dibujarFila(
      page,
      y,
      filaSubtotal(totalDebitoGeneral, totalCreditoGeneral),
      { bold: true, fondo: true },
    );
  }

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
