import { createElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
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

const FONT_SIZE = 8;
/** A touch smaller than every other column (product decision, 2026-09-20)
 *  — Titular is the one column holding a person's full name, the most
 *  likely to run long, so a slightly smaller font both reads a bit more
 *  compact and leaves `truncarTexto` more characters to work with before
 *  it has to cut a name off. */
const FONT_SIZE_TITULAR = 7.25;
const COLUMNA_TITULAR = 1;

/** Every column used to split the content width evenly, which starved
 *  "Titular" (a person's full name, the one column someone actually needs
 *  to read in full) down to the same width as a six-digit currency column.
 *  Now every numeric column gets a fixed, generous-enough width, and
 *  Titular takes whatever is left — it's the only column with genuinely
 *  unpredictable content length. */
const ANCHO_CODIGO = 45;
const ANCHO_AREA = 45;
const ANCHO_PARTICIPACION = 55;
const ANCHO_CONCEPTO = 60;
const ANCHO_TITULAR_MINIMO = 120;

/** Fixed widths for Código/Área/Particip. %/each concepto; Titular gets the
 *  remainder of the content width. If enough concepto columns exist that
 *  they would otherwise crowd Titular below its minimum, concepto columns
 *  shrink first — a coproperty with many charge concepts still needs the
 *  name readable more than it needs those columns at full width. */
function anchosDeColumna(cantidadConceptos: number): number[] {
  const fijos = ANCHO_CODIGO + ANCHO_AREA + ANCHO_PARTICIPACION;
  const disponibleParaConceptos =
    CONTENT_WIDTH_PT_HORIZONTAL - fijos - ANCHO_TITULAR_MINIMO;
  const anchoConcepto =
    cantidadConceptos > 0
      ? Math.min(ANCHO_CONCEPTO, disponibleParaConceptos / cantidadConceptos)
      : ANCHO_CONCEPTO;
  const anchoTitular =
    CONTENT_WIDTH_PT_HORIZONTAL - fijos - anchoConcepto * cantidadConceptos;

  return [
    ANCHO_CODIGO,
    anchoTitular,
    ANCHO_AREA,
    ANCHO_PARTICIPACION,
    ...Array.from({ length: cantidadConceptos }, () => anchoConcepto),
  ];
}

/** Rows per page, computed by hand rather than left to react-pdf's automatic
 *  `wrap` pagination — same reasoning as `vencimientos-cartera-pdf.ts`'s own
 *  `FILAS_POR_PAGINA`: a masthead repeated via `fixed` on every page doesn't
 *  reserve its own height against react-pdf's row-fitting estimate. Manual
 *  per-page `<Page>` elements sidestep the interaction entirely.
 *
 *  36 was the original value and looked reasonable on paper, but a rendered
 *  test with 60 rows (confirmed 2026-09-20) showed it actually overflows
 *  the page: react-pdf silently wraps the excess onto an extra, blank
 *  continuation page carrying neither the masthead nor the column header —
 *  exactly the "header doesn't repeat" symptom this whole manual-pagination
 *  approach exists to avoid. 30 was verified, on the same 60-row render, to
 *  land exactly on the page boundary with visible headroom to spare. */
const FILAS_POR_PAGINA = 30;

const styles = StyleSheet.create({
  filaEncabezado: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
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
  celdaEncabezado: {
    fontSize: FONT_SIZE,
    fontFamily: 'Helvetica-Bold',
  },
  celda: {
    fontSize: FONT_SIZE,
    fontFamily: 'Helvetica',
  },
  celdaTitular: {
    fontSize: FONT_SIZE_TITULAR,
    fontFamily: 'Helvetica',
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
 * Generates a printable roster of every active unit in the coproperty: código,
 * titular, área, participación (coeficiente), and one column per recurring
 * charge — one row per unit rather than one document per unit, unlike every
 * other PDF builder here, and unlike Cartera por Conceptos/Consulta de
 * Facturación this never caps or groups concept columns: every concepto in
 * the catalog gets its own, shrinking width instead.
 *
 * Every page repeats the same header (nombre, NIT, título, and "Generado:"
 * right under the title — see `EncabezadoInforme`'s own `fechaGeneracionEnTitulo`)
 * plus the column-title bar — a roster long enough to paginate is exactly
 * the case where a reader needs both on every sheet, not just the first.
 * React-pdf, built directly (no pdf-lib version kept behind a `?version=`
 * toggle). Paginated by hand (see `FILAS_POR_PAGINA`'s docblock) — that
 * repetition depends entirely on no page's content actually overflowing
 * past what `FILAS_POR_PAGINA` assumes fits.
 */
export async function generarPdfListadoInmuebles(
  copropiedad: CopropiedadDocument,
  inmuebles: InmuebleListadoItem[],
  conceptos: ConceptoListado[],
): Promise<Buffer> {
  const fechaGeneracion = new Date();
  const columnas = [
    'Código',
    'Titular',
    'Área',
    'Particip. %',
    ...conceptos.map((c) => c.nombre),
  ];
  // Only Código/Titular are text — every other column here is a number.
  const primeraColumnaNumerica = 2;
  const anchos = anchosDeColumna(conceptos.length);

  const celda = (
    texto: string,
    i: number,
    variante: 'encabezado' | 'normal',
  ) => {
    const esTitular = variante === 'normal' && i === COLUMNA_TITULAR;
    const base =
      variante === 'encabezado'
        ? styles.celdaEncabezado
        : esTitular
          ? styles.celdaTitular
          : styles.celda;
    const fontSizeEfectivo = esTitular ? FONT_SIZE_TITULAR : FONT_SIZE;
    const dimensiones: {
      flexGrow: number;
      flexBasis: number;
      textAlign: 'right' | 'left';
    } = {
      flexGrow: anchos[i],
      flexBasis: 0,
      textAlign: i >= primeraColumnaNumerica ? 'right' : 'left',
    };
    // Titular is set in ALL CAPS (see `nombreListadoDe` in
    // `inmuebles-reporte.service.ts`) — capitals and tildes render
    // consistently wider than `truncarTexto`'s 0.52 lowercase-average
    // heuristic assumes, so its default margin still let some full names
    // overflow into a second line despite the smaller `FONT_SIZE_TITULAR`.
    // A wider per-char estimate for this column only truncates a couple of
    // characters sooner — cheap insurance against a wrap that misaligns
    // the whole row against its single-line siblings.
    const anchoPromedioChar = esTitular ? 0.62 : undefined;
    return createElement(
      Text,
      { key: i, style: [base, dimensiones] },
      truncarTexto(texto, anchos[i] - 6, fontSizeEfectivo, anchoPromedioChar),
    );
  };

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

  const bloquesFilas = agruparEnPaginas(filas, FILAS_POR_PAGINA);

  const paginas = bloquesFilas.map((bloque, indicePagina) =>
    createElement(
      View,
      { key: indicePagina, style: { flexDirection: 'column', flexGrow: 1 } },
      createElement(EncabezadoInforme, {
        copropiedad,
        titulo: 'LISTADO DE INMUEBLES',
        fechaGeneracion,
        fechaGeneracionEnTitulo: true,
      }),

      createElement(
        View,
        { style: styles.filaEncabezado, wrap: false },
        ...columnas.map((col, i) => celda(col, i, 'encabezado')),
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

      createElement(CreditoWebsaco, {}),
    ),
  );

  return renderizarPdf(
    reporteDocumentoMultiPagina(paginas, { orientacion: 'horizontal' }),
  );
}
