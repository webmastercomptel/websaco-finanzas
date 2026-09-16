import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  contenedor: {
    marginTop: 10,
    marginBottom: 6,
  },
  titulo: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  regla: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#999999',
  },
});

/**
 * Section heading (bold) with a thin gray rule below — react-pdf equivalent
 * of `escribirTituloSeccion` (Estado de Cuenta's "Resumen de Saldos",
 * "Detalle de Movimientos", "Anticipos Pendientes").
 */
export function TituloSeccion(props: { texto: string }): ReactElement {
  return createElement(
    View,
    { style: styles.contenedor, wrap: false },
    createElement(Text, { style: styles.titulo }, props.texto),
    createElement(View, { style: styles.regla }),
  );
}
