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
    fontFamily: 'Helvetica',
  },
});

/**
 * Light label/value metadata row — plain text, not bold. For a
 * header-metadata block like Estado de Cuenta's "Generado / Inmueble /
 * Propietario / Periodo": four `FilaLabelValor` in a row (bold value) read
 * as a wall of bold text — heavier than a plain metadata block needs.
 * One black throughout, same as the rest of the document — red/green stay
 * reserved for where they carry real meaning (a status, a discount).
 * `FilaLabelValor` stays reserved for values that actually need the
 * emphasis (Cartera General/Conciliación's KPI figures).
 */
export function FilaInfo(props: {
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
