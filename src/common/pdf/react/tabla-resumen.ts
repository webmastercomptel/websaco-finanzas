import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { TEXTO_MUTED } from './paleta';

export interface FilaResumen {
  label: string;
  valor: string;
  /** Text color override for the value — e.g. the same green/red the
   *  on-screen `Badge`/`text-success` convention uses for a positive
   *  adjustment or an overdue status. Omit for the default black. */
  color?: string;
  /** Marks the row as a running total: bold, slightly larger, separated
   *  from the rows above by a rule — Estado de Cuenta's "Saldo actual". */
  destacada?: boolean;
}

const styles = StyleSheet.create({
  tabla: {
    marginBottom: 8,
  },
  fila: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    paddingHorizontal: 4,
  },
  filaPar: {
    backgroundColor: '#f7f7f7',
  },
  filaDestacada: {
    borderTopWidth: 0.75,
    borderTopColor: '#999999',
    marginTop: 2,
    paddingTop: 5,
  },
  label: {
    fontSize: 9,
    color: TEXTO_MUTED,
  },
  valor: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
  },
  labelDestacada: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
  valorDestacada: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
});

/**
 * A striped label/value summary table — react-pdf equivalent of a plain
 * stack of `FilaLabelValor` rows, but with alternating row backgrounds
 * (same striping `CuerpoFactura`'s charges table uses) and per-row text
 * color, so a status like "Vencida" or a positive adjustment can carry the
 * same red/green meaning the on-screen `Badge`/`text-success` convention
 * already uses instead of reading as plain black text.
 */
export function TablaResumen(props: { filas: FilaResumen[] }): ReactElement {
  return createElement(
    View,
    { style: styles.tabla },
    ...props.filas.map((fila, i) =>
      createElement(
        View,
        {
          key: i,
          style: [
            styles.fila,
            !fila.destacada && i % 2 === 1 ? styles.filaPar : undefined,
            fila.destacada ? styles.filaDestacada : undefined,
          ],
          wrap: false,
        },
        createElement(
          Text,
          { style: fila.destacada ? styles.labelDestacada : styles.label },
          fila.label,
        ),
        createElement(
          Text,
          {
            style: [
              fila.destacada ? styles.valorDestacada : styles.valor,
              fila.color ? { color: fila.color } : undefined,
            ],
          },
          fila.valor,
        ),
      ),
    ),
  );
}
