import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  tabla: {
    marginTop: 4,
    marginBottom: 8,
  },
  filaEncabezado: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#000000',
    paddingBottom: 3,
    marginBottom: 3,
  },
  fila: {
    flexDirection: 'row',
    paddingVertical: 1,
  },
  reglaFinal: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#000000',
  },
  celdaEncabezado: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
  celda: {
    fontSize: 10,
  },
});

/**
 * A ruled table: header row (bold) + data rows, numeric columns
 * right-aligned. React-pdf equivalent of `escribirTabla`. `wrap` on each
 * row keeps a single row from splitting across a page break — react-pdf's
 * automatic pagination otherwise happily cuts a row's cells mid-height.
 *
 * Deliberately does NOT repeat the header row on a page break yet (matching
 * today's pdf-lib behavior, not a regression). That improvement needs the
 * `fixed`+`render` page-callback interaction verified against a report that
 * actually spans pages before it ships — coming in the batch that migrates
 * the wide, genuinely multi-page reports.
 */
export function Tabla(props: {
  columnas: string[];
  filas: string[][];
  columnasNumericas?: number;
  anchosRelativos?: number[];
}): ReactElement {
  const { columnas, filas } = props;
  const numColumnas = columnas.length;
  const pesos = props.anchosRelativos ?? columnas.map(() => 1);
  const primeraNumerica = numColumnas - (props.columnasNumericas ?? 2);

  const celdaStyle = (i: number, encabezado: boolean) => ({
    flexGrow: pesos[i],
    flexBasis: 0,
    textAlign: i >= primeraNumerica ? 'right' : 'left',
    paddingRight: 4,
    ...(encabezado ? styles.celdaEncabezado : styles.celda),
  });

  return createElement(
    View,
    { style: styles.tabla },
    createElement(
      View,
      { style: styles.filaEncabezado, wrap: false },
      ...columnas.map((col, i) =>
        createElement(Text, { key: `h-${i}`, style: celdaStyle(i, true) }, col),
      ),
    ),
    ...filas.map((fila, filaIdx) =>
      createElement(
        View,
        { key: `f-${filaIdx}`, style: styles.fila, wrap: false },
        ...fila.map((celda, i) =>
          createElement(
            Text,
            { key: `c-${filaIdx}-${i}`, style: celdaStyle(i, false) },
            celda ?? '',
          ),
        ),
      ),
    ),
    createElement(View, { style: styles.reglaFinal }),
  );
}
