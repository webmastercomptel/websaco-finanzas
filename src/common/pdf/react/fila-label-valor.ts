import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  fila: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  label: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  valor: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
  },
});

/**
 * One label/value row: label left, value right, on the same line.
 * React-pdf equivalent of `escribirLabelValor` — flexbox handles the
 * left/right split and the value naturally wraps to a second line if the
 * label is long, instead of `escribirLabelValor`'s manual width-sum check.
 */
export function FilaLabelValor(props: {
  label: string;
  valor: string;
}): ReactElement {
  return createElement(
    View,
    { style: styles.fila, wrap: false },
    createElement(Text, { style: styles.label }, props.label),
    createElement(Text, { style: styles.valor }, props.valor),
  );
}
