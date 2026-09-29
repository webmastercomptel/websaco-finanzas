import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import type { Style } from '@react-pdf/types';
import {
  CONTENT_WIDTH_PT_HORIZONTAL,
  reporteDocumentoMultiPagina,
  renderizarPdf,
} from './document';
import { CreditoWebsaco } from './credito-websaco';
import { FONDO_ZEBRA } from './paleta';
import { truncarTexto } from './text-measure';

/** Same 7pt data / 8pt header font as `consulta-facturacion-pdf.ts`
 *  (product request, 2026-09-28: "fuente del mismo tamaño del listado de
 *  facturación"). */
const FONT_TITULO = 8;
const FONT_DATOS = 7;

/** Rendered height (pt) of each line kind, measured off a real render: a
 *  data row is 7pt text + 2×2pt padding; a subtotal adds its 0.5pt rule; a
 *  group header adds its 4pt top margin. Pagination budgets by height, not
 *  by line count — counting every line as equal left pages a third empty
 *  whenever groups were short (reported 2026-09-29). */
const ALTO_LINEA: Record<LineaTablaAgrupada['clase'], number> = {
  documento: 11.5,
  subtotal: 12,
  grupo: 15.5,
};

/** Height (pt) available for lines on one landscape page: 564pt inside the
 *  margins, minus the masthead with up to two subtitle lines and the column
 *  header (~132pt), the TOTALES row (~20pt), the footer (~24pt) and a few
 *  points of slack against line-height rounding. */
const ALTO_DISPONIBLE = 395;

/** Horizontal padding every cell carries. A merged cell spanning `n`
 *  columns carries the padding of all `n` (the extra on its right), or
 *  flexbox would hand it a different share of the free space than the `n`
 *  separate cells above it get, and every numeric column to its right would
 *  drift out of line with the rows above. */
const PADDING = 4;

const styles = StyleSheet.create({
  filaEncabezado: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    borderBottomWidth: 0.75,
    borderBottomColor: '#000000',
    paddingVertical: 3,
    marginTop: 6,
  },
  filaGrupo: {
    flexDirection: 'row',
    backgroundColor: '#e6e6e6',
    paddingVertical: 2,
    marginTop: 4,
  },
  fila: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  filaPar: {
    backgroundColor: FONDO_ZEBRA,
  },
  filaSubtotal: {
    flexDirection: 'row',
    borderTopWidth: 0.5,
    borderTopColor: '#000000',
    paddingVertical: 2,
  },
  filaTotales: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    borderTopWidth: 0.75,
    borderTopColor: '#000000',
    paddingVertical: 3,
    marginTop: 6,
  },
  negrita: {
    fontFamily: 'Helvetica-Bold',
  },
  normal: {
    fontFamily: 'Helvetica',
  },
});

/** One column of a grouped report table. Numeric columns are always the
 *  trailing ones — a subtotal/total row merges every non-numeric column
 *  into its label cell and only fills in the numeric ones. */
export interface ColumnaTablaAgrupada {
  titulo: string;
  peso: number;
  numerica: boolean;
}

/** One printed line of a grouped report table: a group's header, one data
 *  row, or a group's subtotal. */
export type LineaTablaAgrupada =
  | { clase: 'grupo'; texto: string }
  | { clase: 'documento'; celdas: string[]; par: boolean }
  | { clase: 'subtotal'; etiqueta: string; valores: string[] };

/** A document's number without its type prefix ("FV-0012" → "0012") for
 *  layouts where Tipo has its own column; falls back to the full string
 *  when stripping would leave nothing (a number that's all letters). */
export function numeroSinTipo(numeroCompleto: string): string {
  return (
    numeroCompleto.replace(/^[A-Za-zÁÉÍÓÚÑáéíóúñ]+[\s-]*/, '') || numeroCompleto
  );
}

const altoDe = (lineas: LineaTablaAgrupada[]): number =>
  lineas.reduce((sum, l) => sum + ALTO_LINEA[l.clase], 0);

/** Splits groups of lines into pages of at most `ALTO_DISPONIBLE` points. A
 *  group that doesn't fit in what's left of the current page but fits on a
 *  fresh one starts a new page, so a group's header, rows and subtotal stay
 *  together; only a group taller than a whole page is split line by line. */
function paginarGrupos(grupos: LineaTablaAgrupada[][]): LineaTablaAgrupada[][] {
  const paginas: LineaTablaAgrupada[][] = [];
  let actual: LineaTablaAgrupada[] = [];
  let alto = 0;
  const cerrarPagina = (): void => {
    paginas.push(actual);
    actual = [];
    alto = 0;
  };
  for (const grupo of grupos) {
    const altoGrupo = altoDe(grupo);
    if (
      actual.length > 0 &&
      alto + altoGrupo > ALTO_DISPONIBLE &&
      altoGrupo <= ALTO_DISPONIBLE
    ) {
      cerrarPagina();
    }
    for (const linea of grupo) {
      const altoLinea = ALTO_LINEA[linea.clase];
      if (actual.length > 0 && alto + altoLinea > ALTO_DISPONIBLE) {
        cerrarPagina();
      }
      actual.push(linea);
      alto += altoLinea;
    }
  }
  paginas.push(actual);
  return paginas;
}

/**
 * A landscape, multi-page report table grouped by inmueble (product
 * request, 2026-09-28): each group opens with a header line, lists its
 * rows, and closes with its own subtotal; a final TOTALES row closes the
 * last page. A "resumido" layout passes one single-row group per inmueble
 * (no header, no subtotal). Same 7/8pt fonts, text truncation and manual
 * pagination as `consulta-facturacion-pdf.ts` — see `vencimientos-cartera-pdf.ts`
 * history for why pagination is manual rather than react-pdf's `wrap`.
 * Shared by Cartera por Conceptos and Vencimientos de Cartera.
 */
export function construirPdfTablaAgrupada(
  crearEncabezado: () => ReactElement,
  columnas: ColumnaTablaAgrupada[],
  grupos: LineaTablaAgrupada[][],
  totales: { etiqueta: string; valores: string[] },
  /** Printed in the footer next to "Generado con" — see `CreditoWebsaco`. */
  fechaGeneracion?: Date,
): Promise<Buffer> {
  const pesos = columnas.map((c) => c.peso);
  const pesoTotal = pesos.reduce((a, b) => a + b, 0);
  const primeraNumerica = columnas.findIndex((c) => c.numerica);
  const pesoEtiqueta = pesos
    .slice(0, primeraNumerica)
    .reduce((a, b) => a + b, 0);

  const texto = (
    contenido: string,
    peso: number,
    opciones: {
      numerica: boolean;
      negrita: boolean;
      fontSize: number;
      columnasAbarcadas?: number;
    },
    key: string | number,
  ): ReactElement => {
    const abarcadas = opciones.columnasAbarcadas ?? 1;
    const dimensiones: Style = {
      flexGrow: peso,
      flexBasis: 0,
      fontSize: opciones.fontSize,
      textAlign: opciones.numerica ? 'right' : 'left',
      paddingRight: PADDING + (abarcadas - 1) * PADDING * 2,
      paddingLeft: PADDING,
    };
    const anchoPt = (CONTENT_WIDTH_PT_HORIZONTAL * peso) / pesoTotal;
    return createElement(
      Text,
      {
        key,
        style: [opciones.negrita ? styles.negrita : styles.normal, dimensiones],
      },
      truncarTexto(contenido, anchoPt - 6, opciones.fontSize),
    );
  };

  const filaEtiquetaValores = (
    estilo: Style,
    etiqueta: string,
    valores: string[],
    key: string | number,
  ): ReactElement =>
    createElement(
      View,
      { key, style: estilo, wrap: false },
      texto(
        etiqueta,
        pesoEtiqueta,
        {
          numerica: false,
          negrita: true,
          fontSize: FONT_DATOS,
          columnasAbarcadas: primeraNumerica,
        },
        'etiqueta',
      ),
      ...valores.map((v, i) =>
        texto(
          v,
          pesos[primeraNumerica + i],
          { numerica: true, negrita: true, fontSize: FONT_DATOS },
          i,
        ),
      ),
    );

  const renderLinea = (
    linea: LineaTablaAgrupada,
    idx: number,
  ): ReactElement => {
    if (linea.clase === 'grupo') {
      return createElement(
        View,
        { key: idx, style: styles.filaGrupo, wrap: false },
        texto(
          linea.texto,
          pesoTotal,
          {
            numerica: false,
            negrita: true,
            fontSize: FONT_DATOS,
            columnasAbarcadas: columnas.length,
          },
          'grupo',
        ),
      );
    }
    if (linea.clase === 'subtotal') {
      return filaEtiquetaValores(
        styles.filaSubtotal,
        linea.etiqueta,
        linea.valores,
        idx,
      );
    }
    return createElement(
      View,
      {
        key: idx,
        style: linea.par ? [styles.fila, styles.filaPar] : styles.fila,
        wrap: false,
      },
      ...linea.celdas.map((v, i) =>
        texto(
          v,
          pesos[i],
          {
            numerica: columnas[i].numerica,
            negrita: false,
            fontSize: FONT_DATOS,
          },
          i,
        ),
      ),
    );
  };

  const bloques = paginarGrupos(grupos);
  const paginas = bloques.map((bloque, i) =>
    createElement(
      View,
      { key: i },
      crearEncabezado(),
      createElement(
        View,
        { style: styles.filaEncabezado, wrap: false },
        ...columnas.map((c, j) =>
          texto(
            c.titulo,
            c.peso,
            { numerica: c.numerica, negrita: true, fontSize: FONT_TITULO },
            j,
          ),
        ),
      ),
      ...bloque.map(renderLinea),
      i === bloques.length - 1
        ? filaEtiquetaValores(
            styles.filaTotales,
            totales.etiqueta,
            totales.valores,
            'totales',
          )
        : null,
      createElement(CreditoWebsaco, { fechaGeneracion }),
    ),
  );
  return renderizarPdf(
    reporteDocumentoMultiPagina(paginas, { orientacion: 'horizontal' }),
  );
}
