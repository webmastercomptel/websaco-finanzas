/** The minimal per-line shape this calculation needs — decoupled from the
 *  full `FacturaLinea` document type so it stays assignable from both a
 *  frozen `Factura.lineas` and a still-editable `FacturaPreliminar.lineas`. */
export interface LineaParaDescuento {
  tipoConcepto: 'administracion' | 'intereses' | 'otro';
  valorBase: number;
  valorTotal: number;
}

export interface DescuentoProntoPago {
  discountAmount: number;
  discountDeadline: Date | null;
}

const SIN_DESCUENTO: DescuentoProntoPago = {
  discountAmount: 0,
  discountDeadline: null,
};

/**
 * Computes the early-payment discount ONE invoice/preliminar offers, from
 * the lote's own `descuentoProntoPago` (%) / `valorFijoDescuentoProntoPago`
 * ("Descuento Pronto Pago"/"Valor Fijo Descuento" on the Lote screen,
 * themselves inherited from Parámetros de Facturación at `crear()` time —
 * see `LotesFacturacionService.crear()`) and `fechaLimiteDescuento` ("Fecha
 * límite para descuento"). The two amount forms are MUTUALLY EXCLUSIVE:
 * the percentage wins whenever it is configured (`> 0`); the fixed value is
 * used ONLY as a fallback, taken verbatim with no calculation.
 *
 * Applied to the Administración line's own `valorBase`, same target as
 * the mora calculation, "el saldo anterior que tenga el cargo de
 * administración" (confirmed with product for mora; mirrored here) — never
 * to the whole invoice, which would mix in multas/otros ingresos the
 * discount was never meant to touch.
 *
 * Returns "no discount" (`discountAmount: 0`, `discountDeadline: null`)
 * when there is nothing to offer: no percentage AND no fixed value
 * configured, no Administración line on this document, the computed
 * amount rounds to 0 or below, or — the default business rule — this
 * cycle already charged mora. `descuentoAplicaConMora` (Parámetros de
 * Facturación's own "Descuento Aplica Con Mora" toggle,
 * `Copropiedad.descuentoAplicaConMora`) is the explicit override: when
 * `true`, mora no longer forfeits the discount.
 *
 * The result is computed ONCE — at a real invoice's `consolidar()` time,
 * frozen onto `Factura.montoDescuento`/`fechaLimiteDescuento` forever after
 * (same immutability as every other invoice fact) — or live, every call,
 * for a still-editable `FacturaPreliminar` (`paginaPrefactura`, called
 * fresh on every request — see `LotesController`'s prefactura routes),
 * which has nothing to freeze yet.
 */
export function calcularDescuentoProntoPago(
  lines: LineaParaDescuento[],
  earlyPaymentDiscount: number,
  earlyPaymentDiscountFixedValue: number,
  discountDeadline: Date,
  descuentoAplicaConMora: boolean,
): DescuentoProntoPago {
  const tieneMora = lines.some(
    (l) => l.tipoConcepto === 'intereses' && l.valorTotal > 0,
  );
  if (tieneMora && !descuentoAplicaConMora) return SIN_DESCUENTO;

  const administracion = lines.find((l) => l.tipoConcepto === 'administracion');
  if (!administracion) return SIN_DESCUENTO;

  let monto = 0;
  if (earlyPaymentDiscount > 0) {
    monto = Math.round(administracion.valorBase * (earlyPaymentDiscount / 100));
  } else if (earlyPaymentDiscountFixedValue > 0) {
    monto = earlyPaymentDiscountFixedValue;
  }
  if (monto <= 0) return SIN_DESCUENTO;

  return { discountAmount: monto, discountDeadline };
}
