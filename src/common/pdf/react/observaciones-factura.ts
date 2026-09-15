import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha } from '../pdf-helpers';

/** Same amber "needs attention soon" semantic as the frontend's own
 *  `Badge` `warn` tone (`bg-warning/15 text-warning`, `--warning: oklch(0.5
 *  0.15 85)`) — react-pdf's color parser doesn't accept `oklch()`, so this
 *  is a hand-picked hex match for that same hue rather than the token
 *  itself. A discount is a positive, time-boxed opportunity, not a
 *  problem — `warn` (amber), not `danger` (red), is the correct tone per
 *  `Badge`'s own docblock ("warn is for something that needs attention
 *  soon, danger for something already wrong"). The pdf-lib original used
 *  plain bold red text for this; that was a straight carry-over from the
 *  no-design-system pdf-lib era, not a deliberate choice to keep. */
const AMBAR_TEXTO = '#92400e';
const AMBAR_BORDE = '#f3d27a';
const AMBAR_FONDO = '#fef3c7';

const styles = StyleSheet.create({
  contenedor: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 12,
  },
  caja: {
    flexGrow: 1,
    flexBasis: 0,
    justifyContent: 'center',
    borderWidth: 0.75,
    borderColor: '#bfbfbf',
    borderRadius: 3,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  textoCaja: {
    fontSize: 8.5,
    textAlign: 'center',
  },
  descuento: {
    flexGrow: 1,
    flexBasis: 0,
    justifyContent: 'center',
    marginLeft: 20,
    backgroundColor: AMBAR_FONDO,
    borderWidth: 0.75,
    borderColor: AMBAR_BORDE,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  descuentoTitulo: {
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    color: AMBAR_TEXTO,
    textAlign: 'center',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  descuentoFecha: {
    fontSize: 8.5,
    color: AMBAR_TEXTO,
    textAlign: 'center',
    marginBottom: 3,
  },
  descuentoMonto: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: AMBAR_TEXTO,
    textAlign: 'center',
  },
});

/** Early-payment-discount line, if this Factura has one still open —
 *  same fields `evaluarAplicacionConDescuento` already reasons about
 *  (`discountAmount`/`discountDeadline`). */
export interface DescuentoProntoPago {
  fechaLimite: string;
  montoConDescuento: number;
}

/**
 * Observaciones: a bordered box (payment instructions — bank account to
 * consignar, or whatever free text the copropiedad configured) alongside,
 * conditionally, the early-payment-discount callout — an amber card (see
 * `AMBAR_*` above), not plain red text: a discount is an opportunity, not a
 * warning. Both halves are independently optional — a Factura with no
 * discount open just renders the box alone; one with neither renders
 * nothing (the caller skips this component entirely rather than rendering
 * an empty shell).
 *
 * Space reserved here, not yet built: a QR code alongside this block —
 * flagged by the design but out of scope for this pass.
 */
export function ObservacionesFactura(props: {
  texto: string | null;
  descuento?: DescuentoProntoPago;
}): ReactElement {
  const { texto, descuento } = props;

  return createElement(
    View,
    { style: styles.contenedor },
    texto
      ? createElement(
          View,
          { style: styles.caja },
          createElement(Text, { style: styles.textoCaja }, texto),
        )
      : null,
    descuento
      ? createElement(
          View,
          { style: styles.descuento },
          createElement(Text, { style: styles.descuentoTitulo }, 'Descuento Pronto Pago'),
          createElement(
            Text,
            { style: styles.descuentoFecha },
            `Si cancela antes del ${formatoFecha(descuento.fechaLimite)}`,
          ),
          createElement(
            Text,
            { style: styles.descuentoMonto },
            `$ ${descuento.montoConDescuento.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`,
          ),
        )
      : null,
  );
}
