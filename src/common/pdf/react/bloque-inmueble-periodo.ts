import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  bloque: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  bloqueIzquierda: {
    width: 300,
  },
  filaSimple: {
    flexDirection: 'row',
    marginBottom: 2,
  },
  filaSimpleLabel: {
    width: 55,
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  texto: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  periodo: {
    flexDirection: 'row',
  },
});

/** Label in a fixed-width box + value right after with a small gap — the
 *  column-aligned convention `DatosAdquiriente` uses, not `FilaInfo`'s
 *  space-between (which spreads label and value edge to edge). */
const filaSimple = (label: string, valor: string, key: string): ReactElement =>
  createElement(
    View,
    { key, style: styles.filaSimple },
    createElement(Text, { style: styles.filaSimpleLabel }, label),
    createElement(Text, { style: styles.texto }, valor),
  );

/**
 * "Inmueble / Nombre" on the left, "Periodo: <desde> al <hasta>" on the
 * right — the unit block under the letterhead of Auxiliar de Cartera, shared
 * with Estado de Cuenta so both statements read the same (product request,
 * 2026-09-28). Dates arrive already formatted.
 */
export function BloqueInmueblePeriodo(props: {
  inmuebleCodigo: string;
  propietario: string | null;
  desde: string;
  hasta: string;
}): ReactElement {
  return createElement(
    View,
    { style: styles.bloque },
    createElement(
      View,
      { style: styles.bloqueIzquierda },
      filaSimple('Inmueble:', props.inmuebleCodigo, 'inmueble'),
      filaSimple('Nombre:', props.propietario ?? '—', 'nombre'),
    ),
    createElement(
      View,
      { style: styles.periodo },
      createElement(Text, { style: styles.texto }, 'Periodo: '),
      createElement(
        Text,
        { style: styles.texto },
        `${props.desde} al ${props.hasta}`,
      ),
    ),
  );
}
