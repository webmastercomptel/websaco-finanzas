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
