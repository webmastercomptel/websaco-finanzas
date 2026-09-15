import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoPeso } from '../pdf-helpers';

const PESOS = [2.4, 1, 1, 1.1];

const styles = StyleSheet.create({
  tabla: {
    marginBottom: 10,
  },
  filaEncabezado: {
    flexDirection: 'row',
    borderBottomWidth: 0.75,
    borderBottomColor: '#000000',
    paddingBottom: 5,
    marginBottom: 4,
  },
  fila: {
    flexDirection: 'row',
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  filaPar: {
    backgroundColor: '#f5f5f5',
  },
  reglaTotales: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#999999',
    marginTop: 2,
    marginBottom: 4,
  },
  filaTotales: {
    flexDirection: 'row',
    paddingVertical: 2,
    marginBottom: 8,
  },
  bandaPagar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#e6e6e6',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  celdaEncabezado: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
  },
  celda: {
    fontSize: 8.5,
  },
  celdaTotales: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
  },
  etiquetaPagar: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
  },
  valorPagar: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
  },
});

const celdaStyle = (i: number, extra?: object) => ({
  flexGrow: PESOS[i],
  flexBasis: 0,
  textAlign: i === 0 ? ('left' as const) : ('right' as const),
  paddingRight: i === PESOS.length - 1 ? 0 : 8,
  ...extra,
});

export interface CargoFactura {
  nombre: string;
  saldoAnterior: number;
  cargosDelMes: number;
  nuevoSaldo: number;
}

/**
 * Factura's own charges table: one row per concepto (Nombre del Cargo,
 * Saldo Anterior, Cargos del Mes, Nuevo Saldo), a bold "Totales" row closed
 * by a rule, then a full-width shaded "Total a Pagar $" band — approved
 * design. Kept as its own component (not the generic `Tabla`) because
 * `Tabla` has no notion of a bold totals row or a banner row after it.
 */
export function CuerpoFactura(props: {
  cargos: CargoFactura[];
  totalSaldoAnterior: number;
  totalCargosDelMes: number;
  totalNuevoSaldo: number;
  totalAPagar: number;
}): ReactElement {
  const {
    cargos,
    totalSaldoAnterior,
    totalCargosDelMes,
    totalNuevoSaldo,
    totalAPagar,
  } = props;

  const columnas = [
    'Nombre del Cargo',
    'Saldo Anterior',
    'Cargos del Mes',
    'Nuevo Saldo',
  ];

  return createElement(
    View,
    null,
    createElement(
      View,
      { style: styles.tabla },
      createElement(
        View,
        { style: styles.filaEncabezado, wrap: false },
        ...columnas.map((col, i) =>
          createElement(
            Text,
            { key: `h-${i}`, style: celdaStyle(i, styles.celdaEncabezado) },
            col,
          ),
        ),
      ),
      ...cargos.map((c, filaIdx) =>
        createElement(
          View,
          {
            key: `f-${filaIdx}`,
            style:
              filaIdx % 2 === 1 ? [styles.fila, styles.filaPar] : styles.fila,
            wrap: false,
          },
          createElement(Text, { style: celdaStyle(0, styles.celda) }, c.nombre),
          createElement(
            Text,
            { style: celdaStyle(1, styles.celda) },
            formatoPeso(c.saldoAnterior),
          ),
          createElement(
            Text,
            { style: celdaStyle(2, styles.celda) },
            formatoPeso(c.cargosDelMes),
          ),
          createElement(
            Text,
            { style: celdaStyle(3, styles.celda) },
            formatoPeso(c.nuevoSaldo),
          ),
        ),
      ),
      createElement(View, { style: styles.reglaTotales }),
      createElement(
        View,
        { style: styles.filaTotales, wrap: false },
        createElement(
          Text,
          { style: celdaStyle(0, styles.celdaTotales) },
          'Totales',
        ),
        createElement(
          Text,
          { style: celdaStyle(1, styles.celdaTotales) },
          formatoPeso(totalSaldoAnterior),
        ),
        createElement(
          Text,
          { style: celdaStyle(2, styles.celdaTotales) },
          formatoPeso(totalCargosDelMes),
        ),
        createElement(
          Text,
          { style: celdaStyle(3, styles.celdaTotales) },
          formatoPeso(totalNuevoSaldo),
        ),
      ),
    ),
    createElement(
      View,
      { style: styles.bandaPagar, wrap: false },
      createElement(Text, { style: styles.etiquetaPagar }, 'Total a Pagar $'),
      createElement(
        Text,
        { style: styles.valorPagar },
        formatoPeso(totalAPagar).replace('$ ', ''),
      ),
    ),
  );
}
