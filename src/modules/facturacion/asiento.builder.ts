import type { Movimiento } from '../../database/schemas/facturacion/asiento-contable.schema';

/** The minimal line shape this builder needs — decoupled from the full
 *  FacturaLinea document type so it stays testable without Mongoose, but
 *  using the exact same (English) field names so a real FacturaLinea is
 *  assignable here without a translation step. */
export interface FacturaLineaParaAsiento {
  accountingIncomeAccount: string | null;
  totalAmount: number;
}

export interface FacturaParaAsiento {
  total: number;
  lines: FacturaLineaParaAsiento[];
}

/**
 * A line with no accounting account assigned still has to post somewhere —
 * this is the reserve account a bookkeeper reviews and corrects, never a
 * silently dropped amount. It exists so an unbalanced entry is never the
 * quiet failure mode of an unconfigured ConceptoCobro.
 */
export const CUENTA_SIN_ASIGNAR = 'SIN-CUENTA-ASIGNADA';

/**
 * Builds the double-entry posting for one consolidated invoice: one debit to
 * the coproperty's receivables account for the full total, and one credit
 * per distinct income account among the invoice's lines — collapsing to
 * exactly one debit and one credit for the common single-concept case,
 * matching the real export's 342-facturas-to-684-asientos ratio.
 *
 * Pure and synchronous on purpose: the double-entry invariant this produces
 * (debits equal credits) has to be checked before anything is written to the
 * database, and a pure function is what makes that check trivial to test in
 * isolation from Mongo.
 */
export function construirMovimientos(
  factura: FacturaParaAsiento,
  cuentaCartera: string,
): Movimiento[] {
  const porCuenta = new Map<string, number>();
  for (const linea of factura.lines) {
    const cuenta = linea.accountingIncomeAccount ?? CUENTA_SIN_ASIGNAR;
    porCuenta.set(cuenta, (porCuenta.get(cuenta) ?? 0) + linea.totalAmount);
  }

  const movimientos: Movimiento[] = [
    {
      account: cuentaCartera,
      type: 'debito',
      amount: factura.total,
      description: 'Cartera por cobrar — factura de venta',
    },
  ];

  for (const [cuenta, valor] of porCuenta) {
    movimientos.push({
      account: cuenta,
      type: 'credito',
      amount: valor,
      description: 'Ingreso por factura de venta',
    });
  }

  return movimientos;
}

/**
 * Builds the double-entry posting for a Recibo's CREATION: always one debit
 * to the account the money physically arrived in, for the FULL
 * `montoAplicado + montoSinAplicar` (= the Recibo's `receivedAmount`) —
 * cash that hit the bank is booked immediately, whether or not any of it has
 * been applied to a document yet. The credit side splits: `cuentaCartera`
 * gets whatever was applied in this same call (skipped when zero — a pure
 * anticipo), and `cuentaAnticipos` (the customer-advance liability) gets
 * whatever remains unapplied (skipped when zero — a fully-applied receipt).
 *
 * Structurally balanced by construction: the single debit always equals the
 * sum of the one or two credits, since callers pass the same split that adds
 * up to `receivedAmount` everywhere else in this service.
 */
export function construirAsientoRecibo(
  destinationAccount: string,
  cuentaCartera: string,
  cuentaAnticipos: string,
  montoAplicado: number,
  montoSinAplicar: number,
): Movimiento[] {
  const movimientos: Movimiento[] = [
    {
      account: destinationAccount,
      type: 'debito',
      amount: montoAplicado + montoSinAplicar,
      description: 'Recaudo recibido — recibo de caja',
    },
  ];

  if (montoAplicado > 0) {
    movimientos.push({
      account: cuentaCartera,
      type: 'credito',
      amount: montoAplicado,
      description: 'Cartera por cobrar — aplicación de recibo de caja',
    });
  }
  if (montoSinAplicar > 0) {
    movimientos.push({
      account: cuentaAnticipos,
      type: 'credito',
      amount: montoSinAplicar,
      description: 'Anticipo de cliente — recibo de caja sin aplicar',
    });
  }

  return movimientos;
}

/**
 * Builds the posting for a LATER, deferred application of an anticipo that
 * was already recorded at creation time (`construirAsientoRecibo` already
 * debited `destinationAccount` for it then) — so this never touches
 * `destinationAccount` again. Only the liability moves to the receivable:
 * debit `cuentaAnticipos`, credit `cuentaCartera`, both for the amount
 * applied in this call only.
 */
export function construirMovimientosAplicacionAnticipo(
  cuentaAnticipos: string,
  cuentaCartera: string,
  montoAplicado: number,
): Movimiento[] {
  return [
    {
      account: cuentaAnticipos,
      type: 'debito',
      amount: montoAplicado,
      description: 'Anticipo aplicado a cartera — recibo de caja',
    },
    {
      account: cuentaCartera,
      type: 'credito',
      amount: montoAplicado,
      description: 'Cartera por cobrar — aplicación de anticipo',
    },
  ];
}

/**
 * Builds the ONE consolidated reversing entry a Recibo void posts, using its
 * own cached totals at void time rather than replaying every prior call
 * (design §5: "posts one consolidated reversing journal entry"). Debits
 * `cuentaCartera` for `montoAplicado` (restoring the AR every application
 * reduced) and `cuentaAnticipos` for `montoSinAplicar` (zeroing whatever
 * liability was left) — skipping whichever would be zero — and always
 * credits `destinationAccount` for the full `montoRecibido`, giving back the
 * original cash entry. Balances exactly because
 * `montoAplicado + montoSinAplicar === montoRecibido` is an invariant this
 * service maintains everywhere else already.
 */
export function construirContraAsientoRecibo(
  destinationAccount: string,
  cuentaCartera: string,
  cuentaAnticipos: string,
  montoAplicado: number,
  montoSinAplicar: number,
  montoRecibido: number,
): Movimiento[] {
  const movimientos: Movimiento[] = [];

  if (montoAplicado > 0) {
    movimientos.push({
      account: cuentaCartera,
      type: 'debito',
      amount: montoAplicado,
      description: 'Reversión de cartera — anulación de recibo de caja',
    });
  }
  if (montoSinAplicar > 0) {
    movimientos.push({
      account: cuentaAnticipos,
      type: 'debito',
      amount: montoSinAplicar,
      description: 'Reversión de anticipo — anulación de recibo de caja',
    });
  }

  movimientos.push({
    account: destinationAccount,
    type: 'credito',
    amount: montoRecibido,
    description: 'Reversión de recaudo — anulación de recibo de caja',
  });

  return movimientos;
}
