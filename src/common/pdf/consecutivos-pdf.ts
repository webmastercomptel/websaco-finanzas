import { type PDFPage, rgb } from 'pdf-lib';
import { crearContexto, formatoFecha, truncateToFit } from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaConsecutivos } from '../../contracts';

const MARGIN = 50;
const ALTO_FILA = 12;
const MARGIN_PIE = 30;

/** Up to 11 concepts get their own column; anything beyond that is summed
 *  into one final "Otros Cargos" column — same cap every other dynamic-
 *  concept report in this module uses (`consulta-facturacion-pdf.ts`,
 *  `cartera-por-inmueble-pdf.ts`). */
const MAX_CARGOS_INDIVIDUALES = 11;

interface ColumnaTabla {
  titulo: string;
  peso: number;
  numerica: boolean;
}

function formatoPesoCompacto(valor: number): string {
  return valor.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

/**
 * Generates a real PDF for Consecutivos: every document of one type ("código"
 * from the Tabla de Documentos) issued within a period, broken down by
 * charge concept — dynamic concept columns like Consulta de Facturación,
 * wide enough that (like `vencimientos-cartera-pdf.ts`/
 * `movimiento-contable-pdf.ts`) this manages its own landscape pagination
 * with a repeating header and a shrunk font.
 */
export async function generarPdfConsecutivos(
  reporte: RespuestaConsecutivos,
  copropiedad: CopropiedadDocument,
  codigo: string,
  desde: string,
  hasta: string,
): Promise<Uint8Array> {
  const ctx = await crearContexto({ orientacion: 'horizontal' });

  const conceptosIndividuales = reporte.conceptos.slice(
    0,
    MAX_CARGOS_INDIVIDUALES,
  );
  const conceptosAgrupados = reporte.conceptos.slice(MAX_CARGOS_INDIVIDUALES);

  const COLUMNAS: ColumnaTabla[] = [
    { titulo: 'Tipo Doc.', peso: 0.7, numerica: false },
    { titulo: 'Número', peso: 1.3, numerica: false },
    { titulo: 'Inmueble', peso: 0.9, numerica: false },
    { titulo: 'Fecha', peso: 0.9, numerica: false },
    { titulo: 'Valor Total', peso: 1.2, numerica: true },
    ...conceptosIndividuales.map((c) => ({
      titulo: c.nombre,
      peso: 1.1,
      numerica: true,
    })),
    ...(conceptosAgrupados.length > 0
      ? [{ titulo: 'Otros Cargos', peso: 1.1, numerica: true }]
      : []),
  ];

  const pesoTotal = COLUMNAS.reduce((acc, c) => acc + c.peso, 0);
  const anchos = COLUMNAS.map((c) => (c.peso / pesoTotal) * ctx.contentWidth);
  const fuenteDatos = Math.max(
    5.5,
    7 - Math.max(0, COLUMNAS.length - 10) * 0.3,
  );
  const fuenteTitulo = Math.max(6, 8 - Math.max(0, COLUMNAS.length - 10) * 0.2);

  const subtitulo = `Consecutivos ${codigo} — ${formatoFecha(desde)} al ${formatoFecha(hasta)}`;
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

  const totalesPorConcepto = new Map<string, number>();
  let totalGeneral = 0;

  for (const f of reporte.filas) {
    if (y < MARGIN_PIE + ALTO_FILA) {
      ({ page, y } = nuevaPagina());
    }
    const otros = conceptosAgrupados.reduce(
      (acc, c) => acc + (f.cargosPorConcepto[c.conceptoId] ?? 0),
      0,
    );
    for (const c of reporte.conceptos) {
      const monto = f.cargosPorConcepto[c.conceptoId] ?? 0;
      totalesPorConcepto.set(
        c.conceptoId,
        (totalesPorConcepto.get(c.conceptoId) ?? 0) + monto,
      );
    }
    totalGeneral += f.valorTotal;

    const celdas = [
      f.tipoDocumento,
      f.numeroCompleto,
      f.inmuebleCodigo,
      formatoFecha(f.fecha),
      formatoPesoCompacto(f.valorTotal),
      ...conceptosIndividuales.map((c) =>
        formatoPesoCompacto(f.cargosPorConcepto[c.conceptoId] ?? 0),
      ),
      ...(conceptosAgrupados.length > 0 ? [formatoPesoCompacto(otros)] : []),
    ];
    dibujarFila(page, y, celdas);
    y -= ALTO_FILA;
  }

  if (y < MARGIN_PIE + ALTO_FILA) {
    ({ page, y } = nuevaPagina());
  }
  const totalOtros = conceptosAgrupados.reduce(
    (acc, c) => acc + (totalesPorConcepto.get(c.conceptoId) ?? 0),
    0,
  );
  if (reporte.filas.length === 0) {
    const mensaje = truncateToFit(
      ctx.font,
      'No hay documentos de este tipo en el período seleccionado',
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
    dibujarFila(
      page,
      y,
      [
        'TOTAL',
        '',
        '',
        '',
        formatoPesoCompacto(totalGeneral),
        ...conceptosIndividuales.map((c) =>
          formatoPesoCompacto(totalesPorConcepto.get(c.conceptoId) ?? 0),
        ),
        ...(conceptosAgrupados.length > 0
          ? [formatoPesoCompacto(totalOtros)]
          : []),
      ],
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
