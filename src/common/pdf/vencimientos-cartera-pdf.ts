import { createElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha } from './pdf-helpers';
import {
  reporteDocumentoMultiPagina,
  renderizarPdf,
  CONTENT_WIDTH_PT_HORIZONTAL,
} from './react/document';
import { CreditoWebsaco } from './react/credito-websaco';
import { EncabezadoInforme } from './react/encabezado-informe';
import { FONDO_ZEBRA } from './react/paleta';
import { truncarTexto } from './react/text-measure';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  RangoVencimiento,
  RespuestaVencimientosCartera,
} from '../../contracts';

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
const PESO_TOTAL = COLUMNAS.reduce((acc, c) => acc + c.peso, 0);
/** Absolute pt widths, precomputed from the same weights the flex columns
 *  use — needed by `truncarTexto`, which measures against a real width,
 *  not a flex ratio. */
const ANCHOS_PT = COLUMNAS.map(
  (c) => (c.peso / PESO_TOTAL) * CONTENT_WIDTH_PT_HORIZONTAL,
);

const FUENTE_DATOS = 6.5;

/** Rows per page, computed by hand rather than left to react-pdf's
 *  automatic `wrap` pagination — a masthead+table-header repeated via
 *  `fixed` on every page turned out to NOT reserve its own height against
 *  react-pdf's row-fitting estimate (verified empirically: raising the
 *  page's bottom padding shrank the row count per page correctly, but the
 *  last 1-2 rows kept overlapping the fixed footer regardless of how much
 *  padding was added — the estimate and the actual fixed-element geometry
 *  were fighting each other, not converging). Manual, per-page `<Page>`
 *  elements (`reporteDocumentoMultiPagina`, already built for the
 *  facturas-lote/prefacturas-lote merge) sidestep the interaction
 *  entirely — same approach the pdf-lib original used (`nuevaPagina()`),
 *  just built once instead of triggered by a live cursor position.
 *  612 (landscape height) − 100 (top+bottom padding) − ~50 (masthead+table
 *  header) − ~20 (footer clearance) ≈ 442pt ÷ ~10.5pt/row ≈ 42; kept at 38
 *  for headroom against `Text`'s own line-height rounding. */
const FILAS_POR_PAGINA = 38;

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

function agruparEnPaginas<T>(items: T[], porPagina: number): T[][] {
  if (items.length === 0) return [[]];
  const paginas: T[][] = [];
  for (let i = 0; i < items.length; i += porPagina) {
    paginas.push(items.slice(i, i + porPagina));
  }
  return paginas;
}

const styles = StyleSheet.create({
  filaEncabezado: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    borderBottomWidth: 0.5,
    borderBottomColor: '#999999',
    paddingVertical: 3,
    marginTop: 6,
    marginBottom: 3,
  },
  fila: {
    flexDirection: 'row',
    paddingVertical: 1.5,
  },
  filaPar: {
    backgroundColor: FONDO_ZEBRA,
  },
  filaFinal: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    paddingVertical: 3,
    marginTop: 2,
  },
  celdaEncabezado: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
  },
  celda: {
    fontSize: FUENTE_DATOS,
    fontFamily: 'Helvetica',
  },
  celdaFinal: {
    fontSize: FUENTE_DATOS,
    fontFamily: 'Helvetica-Bold',
  },
});

const celdaEstilo = (
  i: number,
  variante: 'encabezado' | 'normal' | 'final',
) => ({
  flexGrow: COLUMNAS[i].peso,
  flexBasis: 0,
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- widened to `string` without it; only flagged as unnecessary because the rule ignores the downstream react-pdf Style prop context.
  textAlign: (COLUMNAS[i].numerica ? 'right' : 'left') as 'right' | 'left',
  paddingRight: 3,
  ...(variante === 'encabezado'
    ? styles.celdaEncabezado
    : variante === 'final'
      ? styles.celdaFinal
      : styles.celda),
});

/**
 * Generates a real PDF for Vencimientos de Cartera: every pending document
 * coproperty-wide, aged into its own column — 17 columns total (8 fixed +
 * 9 aging buckets, all fixed, never per-coproperty dynamic). `filtro`
 * narrows to one inmueble and/or one aging bucket, matching whatever's
 * active on screen.
 *
 * React-pdf, built directly (no pdf-lib version kept behind a `?version=`
 * toggle). Paginated by hand (see `FILAS_POR_PAGINA`'s docblock) — one
 * `<Page>` per row-chunk, each carrying its own masthead + table header, the
 * TOTAL row only on the last one.
 */
export async function generarPdfVencimientosCartera(
  reporteCompleto: RespuestaVencimientosCartera,
  copropiedad: CopropiedadDocument,
  filtro: { inmuebleId?: string; rango?: RangoVencimiento } = {},
): Promise<Buffer> {
  const reporte = filtrarReporte(reporteCompleto, filtro);
  const subtitulo = `Corte al ${formatoFecha(reporte.fechaCorte)}`;
  const totalPorRango = new Map(reporte.rangos.map((r) => [r.rango, r.valor]));

  const celda = (
    texto: string,
    i: number,
    variante: 'encabezado' | 'normal' | 'final',
  ) =>
    createElement(
      Text,
      { key: i, style: celdaEstilo(i, variante) },
      variante === 'normal'
        ? truncarTexto(texto, ANCHOS_PT[i], FUENTE_DATOS)
        : texto,
    );

  const bloquesFilas = agruparEnPaginas(reporte.filas, FILAS_POR_PAGINA);
  const fechaGeneracion = new Date();

  const paginas = bloquesFilas.map((bloque, indicePagina) => {
    const esUltima = indicePagina === bloquesFilas.length - 1;

    return createElement(
      View,
      null,
      createElement(EncabezadoInforme, {
        copropiedad,
        titulo: 'VENCIMIENTOS DE CARTERA',
        subtitulo,
        fechaGeneracion,
      }),
      createElement(
        View,
        { style: styles.filaEncabezado, wrap: false },
        ...COLUMNAS.map((c, i) => celda(c.titulo, i, 'encabezado')),
      ),

      ...bloque.map((f, filaIdx) => {
        const valores = [
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
        return createElement(
          View,
          {
            key: filaIdx,
            style:
              filaIdx % 2 === 1 ? [styles.fila, styles.filaPar] : styles.fila,
            wrap: false,
          },
          ...valores.map((v, i) => celda(v, i, 'normal')),
        );
      }),

      esUltima
        ? createElement(
            View,
            { style: styles.filaFinal, wrap: false },
            ...[
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
            ].map((v, i) => celda(v, i, 'final')),
          )
        : null,

      createElement(CreditoWebsaco),
    );
  });

  return renderizarPdf(
    reporteDocumentoMultiPagina(paginas, { orientacion: 'horizontal' }),
  );
}
