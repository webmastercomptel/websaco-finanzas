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
 * Which document produced a cruce entry — Recibos ('RC') or Notas Crédito
 * ('NC'). The ONLY thing this selects is which description strings a journal
 * line gets; every account, amount and debit/credit side is computed
 * identically regardless of `origen` (design §7: "the arithmetic and shape
 * are identical, only the account and description text differ").
 */
export type OrigenAsiento = 'RC' | 'NC' | 'ND';

interface DescripcionesAsiento {
  creacionDebito: string;
  creacionCreditoCartera: string;
  creacionCreditoAnticipo: string;
  aplicacionDebitoAnticipo: string;
  aplicacionCreditoCartera: string;
  contraDebitoCartera: string;
  contraDebitoAnticipo: string;
  contraCredito: string;
}

const DESCRIPCIONES: Record<OrigenAsiento, DescripcionesAsiento> = {
  RC: {
    creacionDebito: 'Recaudo recibido — recibo de caja',
    creacionCreditoCartera: 'Cartera por cobrar — aplicación de recibo de caja',
    creacionCreditoAnticipo: 'Anticipo de cliente — recibo de caja sin aplicar',
    aplicacionDebitoAnticipo: 'Anticipo aplicado a cartera — recibo de caja',
    aplicacionCreditoCartera: 'Cartera por cobrar — aplicación de anticipo',
    contraDebitoCartera: 'Reversión de cartera — anulación de recibo de caja',
    contraDebitoAnticipo: 'Reversión de anticipo — anulación de recibo de caja',
    contraCredito: 'Reversión de recaudo — anulación de recibo de caja',
  },
  NC: {
    creacionDebito: 'Corrección de ingreso — nota crédito',
    creacionCreditoCartera: 'Cartera por cobrar — aplicación de nota crédito',
    creacionCreditoAnticipo: 'Anticipo de cliente — nota crédito sin aplicar',
    aplicacionDebitoAnticipo: 'Anticipo aplicado a cartera — nota crédito',
    aplicacionCreditoCartera:
      'Cartera por cobrar — aplicación de anticipo de nota crédito',
    contraDebitoCartera: 'Reversión de cartera — anulación de nota crédito',
    contraDebitoAnticipo: 'Reversión de anticipo — anulación de nota crédito',
    contraCredito:
      'Reversión de corrección de ingreso — anulación de nota crédito',
  },
  ND: {
    creacionDebito: 'Cartera por cobrar — nota débito',
    creacionCreditoCartera: 'Ingreso por nota débito',
    creacionCreditoAnticipo: '',
    aplicacionDebitoAnticipo: '',
    aplicacionCreditoCartera: '',
    contraDebitoCartera: 'Reversión de ingreso — anulación de nota débito',
    contraDebitoAnticipo: '',
    contraCredito: 'Reversión de cartera — anulación de nota débito',
  },
};

/**
 * Builds the double-entry posting for a cruce document's CREATION: always
 * one debit to `cuentaOrigen` for the FULL `montoAplicado + montoSinAplicar`
 * — for a Recibo this is the bank/cash account the money arrived in; for a
 * Nota Crédito it is `cuentaDevoluciones`, the expense/contra-revenue
 * account the correction debits. The credit side splits: `cuentaCartera`
 * gets whatever was applied in this same call (skipped when zero), and
 * `cuentaAnticipos` gets whatever remains unapplied (skipped when zero).
 *
 * RENAMED from `construirAsientoRecibo` (Task 2): `destinationAccount` →
 * `cuentaOrigen`, since it is not always a "destination" — for a Nota
 * Crédito nothing is received, something is corrected.
 *
 * Structurally balanced by construction: the single debit always equals the
 * sum of the one or two credits, since callers pass the same split that adds
 * up to the document's own total everywhere else in each service.
 */
export function construirAsientoCruce(
  cuentaOrigen: string,
  cuentaCartera: string,
  cuentaAnticipos: string,
  montoAplicado: number,
  montoSinAplicar: number,
  origen: OrigenAsiento,
): Movimiento[] {
  const d = DESCRIPCIONES[origen];
  const movimientos: Movimiento[] = [
    {
      account: cuentaOrigen,
      type: 'debito',
      amount: montoAplicado + montoSinAplicar,
      description: d.creacionDebito,
    },
  ];

  if (montoAplicado > 0) {
    movimientos.push({
      account: cuentaCartera,
      type: 'credito',
      amount: montoAplicado,
      description: d.creacionCreditoCartera,
    });
  }
  if (montoSinAplicar > 0) {
    movimientos.push({
      account: cuentaAnticipos,
      type: 'credito',
      amount: montoSinAplicar,
      description: d.creacionCreditoAnticipo,
    });
  }

  return movimientos;
}

/**
 * Builds the posting for a LATER, deferred application of an anticipo that
 * was already recorded at creation time (`construirAsientoCruce` already
 * debited `cuentaOrigen` for it then) — so this never touches `cuentaOrigen`
 * again. Only the liability moves to the receivable: debit `cuentaAnticipos`,
 * credit `cuentaCartera`, both for the amount applied in this call only.
 *
 * UNCHANGED name from before Task 2 (it never had an account parameter tied
 * to one side, so there was nothing to rename) — only `origen` is new.
 */
export function construirMovimientosAplicacionAnticipo(
  cuentaAnticipos: string,
  cuentaCartera: string,
  montoAplicado: number,
  origen: OrigenAsiento,
): Movimiento[] {
  const d = DESCRIPCIONES[origen];
  return [
    {
      account: cuentaAnticipos,
      type: 'debito',
      amount: montoAplicado,
      description: d.aplicacionDebitoAnticipo,
    },
    {
      account: cuentaCartera,
      type: 'credito',
      amount: montoAplicado,
      description: d.aplicacionCreditoCartera,
    },
  ];
}

/**
 * Builds the ONE consolidated reversing entry a cruce document's void posts,
 * using its own cached totals at void time rather than replaying every prior
 * call. Debits `cuentaCartera` for `montoAplicado` (restoring the AR every
 * application reduced) and `cuentaAnticipos` for `montoSinAplicar` (zeroing
 * whatever liability was left) — skipping whichever would be zero — and
 * always credits `cuentaOrigen` for the full `montoOrigen`, giving back the
 * original entry. Balances exactly because
 * `montoAplicado + montoSinAplicar === montoOrigen` is an invariant each
 * calling service maintains.
 *
 * RENAMED from `construirContraAsientoRecibo` (Task 2): `destinationAccount`
 * → `cuentaOrigen`, `montoRecibido` → `montoOrigen` (a Nota Crédito's
 * `montoTotal`, not anything "received").
 */
export function construirContraAsientoCruce(
  cuentaOrigen: string,
  cuentaCartera: string,
  cuentaAnticipos: string,
  montoAplicado: number,
  montoSinAplicar: number,
  montoOrigen: number,
  origen: OrigenAsiento,
): Movimiento[] {
  const d = DESCRIPCIONES[origen];
  const movimientos: Movimiento[] = [];

  if (montoAplicado > 0) {
    movimientos.push({
      account: cuentaCartera,
      type: 'debito',
      amount: montoAplicado,
      description: d.contraDebitoCartera,
    });
  }
  if (montoSinAplicar > 0) {
    movimientos.push({
      account: cuentaAnticipos,
      type: 'debito',
      amount: montoSinAplicar,
      description: d.contraDebitoAnticipo,
    });
  }

  movimientos.push({
    account: cuentaOrigen,
    type: 'credito',
    amount: montoOrigen,
    description: d.contraCredito,
  });

  return movimientos;
}

/**
 * Builds the double-entry posting for a reclassification between two
 * conceptos' income accounts — a Nota Contable. Debit `cuentaOrigen`,
 * credit `cuentaDestino`, both for `monto`.
 *
 * Pure and synchronous, same discipline as every other builder function
 * here: the double-entry invariant (debits equal credits) must be
 * verifiable before anything touches the database.
 */
export function construirMovimientosReclasificacion(
  cuentaOrigen: string,
  cuentaDestino: string,
  monto: number,
): Movimiento[] {
  return [
    {
      account: cuentaOrigen,
      type: 'debito',
      amount: monto,
      description: 'Reclasificación de ingreso — nota contable',
    },
    {
      account: cuentaDestino,
      type: 'credito',
      amount: monto,
      description: 'Reclasificación de ingreso — nota contable',
    },
  ];
}

/**
 * Builds the ONE consolidated reversing entry a Nota Débito's void posts.
 * Credits `cuentaCartera` (undoes the AR increase), debits `cuentaIngreso`
 * (undoes the recognized revenue) — a 2-leg reversal, simpler than Recibos'/
 * Notas Crédito's 3-leg version, since a Nota Débito has no anticipo/cash
 * concept.
 */
export function construirContraAsientoNotaDebito(
  cuentaCartera: string,
  cuentaIngreso: string,
  monto: number,
): Movimiento[] {
  return [
    {
      account: cuentaIngreso,
      type: 'debito',
      amount: monto,
      description: 'Reversión de ingreso — anulación de nota débito',
    },
    {
      account: cuentaCartera,
      type: 'credito',
      amount: monto,
      description: 'Reversión de cartera — anulación de nota débito',
    },
  ];
}
