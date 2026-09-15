import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text } from '@react-pdf/renderer';
import { formatoFecha } from '../pdf-helpers';

const styles = StyleSheet.create({
  marca: {
    position: 'absolute',
    top: 340,
    left: 40,
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    color: '#d9d9d9',
    transform: 'rotate(-28deg)',
  },
});

/**
 * "DUPLICADO — Documento original emitido el {fecha}", light gray, rotated,
 * behind the real content. React-pdf equivalent of pdf-lib's
 * `dibujarMarcaDuplicadoFondo` — must be the FIRST child on the page (same
 * reasoning as the pdf-lib original: every opaque element painted after it
 * in document order lands on top, so the stamp only shows through blank
 * space instead of garbling the table/box it would otherwise cross).
 *
 * react-pdf's `position: 'absolute'` is top-left-origin (CSS-like), unlike
 * pdf-lib's bottom-left-origin `y` — `top: 340` is this component's own
 * coordinate, not a port of pdf-lib's `pageHeight * 0.4`.
 */
export function MarcaDuplicado(props: {
  fechaEmisionIso: string | null;
}): ReactElement {
  const texto = props.fechaEmisionIso
    ? `DUPLICADO — Documento original emitido el ${formatoFecha(props.fechaEmisionIso)}`
    : 'DUPLICADO — Documento Original';
  return createElement(Text, { style: styles.marca }, texto);
}
