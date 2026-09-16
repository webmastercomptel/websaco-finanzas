import { createElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import type { Style } from '@react-pdf/types';
import {
  reporteDocumentoMultiPagina,
  renderizarPdf,
  CONTENT_WIDTH_PT_HORIZONTAL,
} from './react/document';
import { CreditoWebsaco } from './react/credito-websaco';
import { FONDO_ZEBRA } from './react/paleta';
import { truncarTexto } from './react/text-measure';
import { formatoFecha } from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaConsultaFacturacion } from '../../contracts';

/** Up to 11 concepts get their own column; anything beyond that is summed
 *  into one final "Otros Cargos" column — per product decision, a
 *  coproperty with 11 concepts or fewer never shows that grouped column at
 *  all (see `construirColumnas`). */
const MAX_CARGOS_INDIVIDUALES = 11;
const FONT_TITULO = 8;
const FONT_DATA = 7;

/** Rows per page, computed by hand rather than left to react-pdf's automatic
 *  `wrap` pagination — same reasoning as `vencimientos-cartera-pdf.ts`'s own
 *  `FILAS_POR_PAGINA`. */
const FILAS_POR_PAGINA = 30;

/** Same grouping-thousands format as `formatoPeso`, minus the "$ " prefix —
 *  this table is dense enough (up to sixteen columns) that the symbol on
 *  every cell would cost more width than it's worth; the "Total Factura"
 *  column header already says these are money. */
function formatoPesoCompacto(valor: number): string {
  return valor.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

function formatoFechaHora(fecha: Date): string {
  return `${fecha.toLocaleDateString('es-CO')} ${fecha.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Bogota' })}`;
}

interface ColumnaTabla {
  titulo: string;
  /** Relative weight, not points — normalized against the content width
   *  once the full column set (fixed 4 + up to 12 dynamic) is known, so the
   *  table always fills the page regardless of how many concept columns a
   *  coproperty ends up with. */
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

const styles = StyleSheet.create({
  masthead: {
    marginBottom: 6,
  },
  filaNombre: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  nombre: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
  },
  generado: {
    fontSize: 8,
    fontFamily: 'Helvetica',
    color: '#4d4d4d',
  },
  subtitulo: {
    fontFamily: 'Helvetica-Bold',
    marginTop: 2,
  },
  regla: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#999999',
    marginTop: 4,
  },
  filaEncabezado: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    borderBottomWidth: 0.75,
    borderBottomColor: '#000000',
    paddingVertical: 3,
    marginTop: 6,
  },
  fila: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  filaPar: {
    backgroundColor: FONDO_ZEBRA,
  },
  filaTotales: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    paddingVertical: 3,
    marginTop: 1,
  },
  celdaEncabezado: {
    fontFamily: 'Helvetica-Bold',
  },
  celdaNormal: {
    fontFamily: 'Helvetica',
  },
  celdaTotales: {
    fontFamily: 'Helvetica-Bold',
  },
});

function agruparEnPaginas<T>(items: T[], porPagina: number): T[][] {
  if (items.length === 0) return [[]];
  const paginas: T[][] = [];
  for (let i = 0; i < items.length; i += porPagina) {
    paginas.push(items.slice(i, i + porPagina));
  }
  return paginas;
}

/**
 * Generates the "Consulta de Facturación" report PDF: a single unified,
 * landscape table — one row per Factura of the lote, columns No. Factura /
 * Inmueble / Fecha / Total Factura, then up to eleven individual concept
 * columns and (only when the coproperty has more than eleven concepts) one
 * final "Otros Cargos" column summing the rest. A two-line masthead
 * (coproperty name + generation timestamp; report title + billing period)
 * repeats on every page — modeled after the predecessor system's own
 * printed listing, adapted for a dynamic concept count instead of the
 * predecessor's hardcoded twelve. React-pdf, built directly (no pdf-lib
 * version kept behind a `?version=` toggle). Paginated by hand (see
 * `FILAS_POR_PAGINA`'s docblock).
 */
export async function generarPdfConsultaFacturacion(
  reporte: RespuestaConsultaFacturacion,
  copropiedad: CopropiedadDocument,
): Promise<Buffer> {
  const generadoEl = new Date();
  const { columnas, conceptosIndividuales, conceptosAgrupados } =
    construirColumnas(reporte);
  const hayOtros = conceptosAgrupados.length > 0;

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

  const anchos = columnas.map((c) => c.peso);

  const celda = (
    texto: string,
    i: number,
    variante: 'encabezado' | 'normal' | 'totales',
  ) => {
    const base =
      variante === 'encabezado'
        ? styles.celdaEncabezado
        : variante === 'totales'
          ? styles.celdaTotales
          : styles.celdaNormal;
    const dimensiones: Style = {
      flexGrow: anchos[i],
      flexBasis: 0,
      fontSize: variante === 'encabezado' ? fuenteTitulo : fuenteDatos,
      textAlign: columnas[i].numerica ? 'right' : 'left',
      paddingRight: 4,
      paddingLeft: 4,
    };
    const pesoTotal = anchos.reduce((a, b) => a + b, 0);
    const anchoColumnaPt =
      (CONTENT_WIDTH_PT_HORIZONTAL * anchos[i]) / pesoTotal;
    return createElement(
      Text,
      { key: i, style: [base, dimensiones] },
      truncarTexto(texto, anchoColumnaPt - 6, dimensiones.fontSize as number),
    );
  };

  const filas = reporte.filas.map((f) => {
    const otrosCargos = conceptosAgrupados.reduce(
      (acc, c) => acc + (f.valoresPorConcepto[c.conceptoId] ?? 0),
      0,
    );
    return [
      f.numeroCompleto,
      f.inmuebleCodigo,
      formatoFecha(f.fechaFactura),
      formatoPesoCompacto(f.total),
      ...conceptosIndividuales.map((c) =>
        formatoPesoCompacto(f.valoresPorConcepto[c.conceptoId] ?? 0),
      ),
      ...(hayOtros ? [formatoPesoCompacto(otrosCargos)] : []),
    ];
  });

  const totalOtrosCargos = reporte.filas.reduce(
    (acc, f) =>
      acc +
      conceptosAgrupados.reduce(
        (a, c) => a + (f.valoresPorConcepto[c.conceptoId] ?? 0),
        0,
      ),
    0,
  );
  const filaTotales = [
    'TOTALES',
    '',
    '',
    formatoPesoCompacto(reporte.total),
    ...conceptosIndividuales.map((c) => formatoPesoCompacto(c.monto)),
    ...(hayOtros ? [formatoPesoCompacto(totalOtrosCargos)] : []),
  ];

  const bloques = agruparEnPaginas(filas, FILAS_POR_PAGINA);

  const paginas = bloques.map((bloque, indicePagina) => {
    const esUltima = indicePagina === bloques.length - 1;
    return createElement(
      View,
      { key: indicePagina },
      createElement(
        View,
        { style: styles.masthead },
        createElement(
          View,
          { style: styles.filaNombre },
          createElement(Text, { style: styles.nombre }, copropiedad.name),
          createElement(
            Text,
            { style: styles.generado },
            `Generado: ${formatoFechaHora(generadoEl)}`,
          ),
        ),
        createElement(
          Text,
          { style: [styles.subtitulo, { fontSize: fuenteTitulo }] },
          subtitulo,
        ),
        createElement(View, { style: styles.regla }),
      ),

      createElement(
        View,
        { style: styles.filaEncabezado, wrap: false },
        ...columnas.map((c, i) => celda(c.titulo, i, 'encabezado')),
      ),

      ...bloque.map((fila, filaIdx) =>
        createElement(
          View,
          {
            key: filaIdx,
            style:
              filaIdx % 2 === 1 ? [styles.fila, styles.filaPar] : styles.fila,
            wrap: false,
          },
          ...fila.map((v, i) => celda(v, i, 'normal')),
        ),
      ),

      esUltima
        ? createElement(
            View,
            { style: styles.filaTotales, wrap: false },
            ...filaTotales.map((v, i) => celda(v, i, 'totales')),
          )
        : null,

      createElement(CreditoWebsaco),
    );
  });

  return renderizarPdf(
    reporteDocumentoMultiPagina(paginas, { orientacion: 'horizontal' }),
  );
}
