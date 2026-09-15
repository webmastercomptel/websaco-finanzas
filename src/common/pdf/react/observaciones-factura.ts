import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha } from '../pdf-helpers';

const styles = StyleSheet.create({
  contenedor: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  caja: {
    flexGrow: 1,
    flexBasis: 0,
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
    marginLeft: 20,
  },
  lineaDescuento: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: '#c0392b',
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
 * conditionally, the early-payment-discount callout in red. Both halves are
 * independently optional — a Factura with no discount open just renders
 * the box alone; one with neither renders nothing (the caller skips this
 * component entirely rather than rendering an empty shell).
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
          createElement(
            Text,
            { style: styles.lineaDescuento },
            `Si cancela antes del ${formatoFecha(descuento.fechaLimite)}`,
          ),
          createElement(
            Text,
            { style: styles.lineaDescuento },
            `Cancele $: ${descuento.montoConDescuento.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`,
          ),
        )
      : null,
  );
}
