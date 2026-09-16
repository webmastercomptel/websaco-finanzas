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
 *  per-page `<Page>` elements sidestep the interaction entirely. */
const FILAS_POR_PAGINA = 36;

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
 * Every page repeats the same three-line header (nombre, NIT, título +
 * fecha de generación) — a roster long enough to paginate is exactly the
 * case where a reader needs it on every sheet, not just the first.
 * React-pdf, built directly (no pdf-lib version kept behind a `?version=`
 * toggle). Paginated by hand (see `FILAS_POR_PAGINA`'s docblock).
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
    const base =
      variante === 'encabezado' ? styles.celdaEncabezado : styles.celda;
    const dimensiones: {
      flexGrow: number;
      flexBasis: number;
      textAlign: 'right' | 'left';
    } = {
      flexGrow: anchos[i],
      flexBasis: 0,
      textAlign: i >= primeraColumnaNumerica ? 'right' : 'left',
    };
    return createElement(
      Text,
      { key: i, style: [base, dimensiones] },
      truncarTexto(texto, anchos[i] - 6, FONT_SIZE),
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

      createElement(CreditoWebsaco),
    ),
  );

  return renderizarPdf(
    reporteDocumentoMultiPagina(paginas, { orientacion: 'horizontal' }),
  );
}
