import type { Movimiento } from '../../database/schemas/facturacion/asiento-contable.schema';

/** The minimal line shape this builder needs — decoupled from the full
 *  FacturaLinea document type so it stays testable without Mongoose, but
 *  using the exact same (English) field names so a real FacturaLinea is
 *  assignable here without a translation step. */
export interface FacturaLineaParaAsiento {
  accountingIncomeAccount: string | null;
  /** This line's DEBIT account. Optional/`null` falls back to
   *  `cuentaCartera` — every caller that predates per-concept debit
   *  accounts (e.g. Nota Débito's single-line posting) keeps its exact
   *  prior behavior without passing this field. */
  accountingReceivableAccount?: string | null;
  /** The concept's `kind` (`ConceptoCobro.kind`/`FacturaLinea.conceptKind`).
   *  Optional so non-invoice callers (e.g. Nota Débito's single-line
   *  posting) that never set it simply never match `'intereses'` below.
   *  Only `'intereses'` is inspected — see `construirMovimientos`'s
   *  cuentasOrden override. */
  conceptKind?: 'administracion' | 'intereses' | 'otro';
  /** The concept's name, exactly as configured in the Cargos tab
   *  (`ConceptoCobro.name`/`FacturaLinea.conceptName`) — used verbatim as
   *  this line's movimiento description, debit and credit alike, so a
   *  bookkeeper reading the ledger sees which cargo each line belongs to.
   *  Optional so non-invoice callers (e.g. Nota Débito's single-line
   *  posting, which has no per-line cargo name to hand over) fall back to
   *  the generic description below. */
  conceptName?: string;
  totalAmount: number;
  /** This line's tax portion (`FacturaLinea.taxAmount`) — optional so every
   *  caller that predates per-line tax splitting (Nota Débito's single-line
   *  posting) keeps crediting the full amount to `accountingIncomeAccount`,
   *  same as before. `> 0` is what triggers the split in
   *  `construirMovimientos`. */
  taxAmount?: number;
  /** This line's tax account (`ConceptoCobro.cuentaImpuestoId`, frozen as
   *  `FacturaLinea.accountingTaxAccount`) — falls back to
   *  `CUENTA_SIN_ASIGNAR` when `taxAmount > 0` but no account is configured,
   *  same reasoning as every other unconfigured-account fallback here. */
  accountingTaxAccount?: string | null;
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

/** The `codeordendb`/`codeordencr` pair from `usesMemorandumAccounts` — see
 *  the note on that field in copropiedad.schema.ts. */
export interface CuentasOrden {
  debito: string;
  credito: string;
}

/** The coproperty shape `cuentasOrdenDe` needs — structurally matches
 *  `CopropiedadDocument`, kept minimal so callers don't have to import it. */
export interface CopropiedadParaCuentasOrden {
  usesMemorandumAccounts: boolean;
  memorandumDebitAccount: string | null;
  memorandumCreditAccount: string | null;
}

/**
 * Resolves the `cuentasOrden` pair every builder below optionally takes, from
 * a coproperty — null when it does not use them. The single place the
 * `CUENTA_SIN_ASIGNAR` fallback for an unconfigured account lives, so every
 * calling service (facturación, recibos, notas) asks the same way instead of
 * repeating the ternary.
 */
export function cuentasOrdenDe(
  copropiedad: CopropiedadParaCuentasOrden | null | undefined,
): CuentasOrden | null {
  if (!copropiedad?.usesMemorandumAccounts) return null;
  return {
    debito: copropiedad.memorandumDebitAccount ?? CUENTA_SIN_ASIGNAR,
    credito: copropiedad.memorandumCreditAccount ?? CUENTA_SIN_ASIGNAR,
  };
}

/**
 * One shared self-balancing debit/credit pair for `cuentasOrden`, at `monto`
 * — appended by every builder below when the coproperty uses them. `[]` when
 * `cuentasOrden` is null, so callers can always splice the result in.
 *
 * `invertido` swaps which side is debited/credited — a void/reversal entry
 * undoing what the original posting added, the same "same shape, accounts
 * swapped" convention every contra-builder here already uses for its real
 * accounts.
 */
function movimientosCuentasOrden(
  cuentasOrden: CuentasOrden | null | undefined,
  monto: number,
  descripcion: string,
  invertido = false,
): Movimiento[] {
  if (!cuentasOrden) return [];
  const debito = invertido ? cuentasOrden.credito : cuentasOrden.debito;
  const credito = invertido ? cuentasOrden.debito : cuentasOrden.credito;
  return [
    {
      account: debito,
      type: 'debito',
      amount: monto,
      description: descripcion,
    },
    {
      account: credito,
      type: 'credito',
      amount: monto,
      description: descripcion,
    },
  ];
}

/**
 * Builds the double-entry posting for one consolidated invoice.
 *
 * ONE DEBIT AND ONE CREDIT PER LINE, never merged across lines (confirmed
 * with product, correcting an earlier merge-by-account reading): two
 * concepts that happen to share an account — e.g. Pintura and Televisión
 * both configured to the same income account — still post as two distinct
 * movimientos, not one collapsed line carrying their combined amount. A
 * cargo that never shows its own line in the ledger is, from a bookkeeper's
 * standpoint, uncoded — silently merging it into a neighboring concept's
 * line was the bug this fixes. A line's debit account is its own
 * `accountingReceivableAccount` — set per `ConceptoCobro.cuentaDebitoId` —
 * falling back to the shared `cuentaCartera` (the coproperty's
 * `receivablesAccount`) when that concept has none configured; its credit
 * account is `accountingIncomeAccount` (`ConceptoCobro.cuentaCreditoId`),
 * falling back to `CUENTA_SIN_ASIGNAR`.
 *
 * PER-LINE override: `cuentasOrden`, when given, replaces the accounts used
 * ONLY for the mora-interest line — `conceptKind === 'intereses'`, the
 * "Cargo 2" of the predecessor system's fixed Administración/Intereses/
 * Multas trio — with `cuentasOrden.debito`/`cuentasOrden.credito` from
 * Parámetros de Facturación instead of that concept's own Cargos accounts.
 * Every other line, and the intereses line itself when `cuentasOrden` is
 * null/undefined, always codes with its own Cargos accounts. This mirrors
 * the predecessor system's `codeordendb`/`codeordencr` mode, which only ever
 * applied to the interest charge, never to the whole invoice.
 *
 * Pure and synchronous on purpose: the double-entry invariant this produces
 * (debits equal credits) has to be checked before anything is written to the
 * database, and a pure function is what makes that check trivial to test in
 * isolation from Mongo.
 *
 * DESCRIPTION per line is the concept's own `conceptName` (Cargos tab), debit
 * and credit alike — so two lines that share an account still read as
 * distinct cargos in the ledger, not just distinct amounts. Falls back to a
 * generic debit/credit description when a caller has no cargo name to give
 * (Nota Débito's single-line posting), or to a "Cuenta de orden" label when
 * the intereses line's own `conceptName` is unavailable but `cuentasOrden`
 * fired — `conceptName`, when present, always wins.
 *
 * TAX SPLIT: a line with `taxAmount > 0` (never true for the `cuentasOrden`
 * path — mora carries no tax) posts its credit side as TWO movements instead
 * of one: `accountingIncomeAccount` for the base only
 * (`totalAmount - taxAmount`), and `accountingTaxAccount` (falling back to
 * `CUENTA_SIN_ASIGNAR`, same as any other unconfigured account) for
 * `taxAmount` — carrying `baseGravable` so the tax line shows what it was
 * computed from. The debit side is unchanged either way: the receivable
 * always covers the full `totalAmount`, tax included. Confirmed with
 * product: crediting the tax portion straight to income (the prior
 * behavior) is wrong — it belongs in its own tax-payable account.
 */
export function construirMovimientos(
  factura: FacturaParaAsiento,
  cuentaCartera: string,
  cuentasOrden?: CuentasOrden | null,
): Movimiento[] {
  const movimientos: Movimiento[] = [];

  for (const linea of factura.lines) {
    const usaCuentasOrden = !!cuentasOrden && linea.conceptKind === 'intereses';
    const debito = usaCuentasOrden
      ? cuentasOrden.debito
      : (linea.accountingReceivableAccount ?? cuentaCartera);
    const credito = usaCuentasOrden
      ? cuentasOrden.credito
      : (linea.accountingIncomeAccount ?? CUENTA_SIN_ASIGNAR);
    const descripcion =
      linea.conceptName ??
      (usaCuentasOrden
        ? 'Cuenta de orden — intereses de mora, factura de venta'
        : undefined);

    movimientos.push({
      account: debito,
      type: 'debito',
      amount: linea.totalAmount,
      description: descripcion ?? 'Cartera por cobrar — factura de venta',
    });

    const taxAmount = linea.taxAmount ?? 0;
    const separaImpuesto = !usaCuentasOrden && taxAmount > 0;
    if (separaImpuesto) {
      const baseGravable = linea.totalAmount - taxAmount;
      movimientos.push({
        account: credito,
        type: 'credito',
        amount: baseGravable,
        description: descripcion ?? 'Ingreso por factura de venta',
      });
      movimientos.push({
        account: linea.accountingTaxAccount ?? CUENTA_SIN_ASIGNAR,
        type: 'credito',
        amount: taxAmount,
        description: `${descripcion ?? 'Ingreso por factura de venta'} — Impuesto`,
        baseGravable,
      });
    } else {
      movimientos.push({
        account: credito,
        type: 'credito',
        amount: linea.totalAmount,
        description: descripcion ?? 'Ingreso por factura de venta',
      });
    }
  }

  return movimientos;
}

/** The chart-of-accounts flags `enriquecerMovimientosConAuxiliares` needs per
 *  account code — a projection of `CuentaContable`, kept minimal so callers
 *  don't have to import the full document type. */
export interface MarcasCuentaContable {
  requiereTercero: boolean;
  centroUtilidad: boolean;
  centroDestino: boolean;
  flujoCaja: boolean;
}

/** The per-transaction values `enriquecerMovimientosConAuxiliares` attaches
 *  when an account's flags call for them — the inmueble's own unit code, and
 *  the coproperty's two single auxiliary codes (Parámetros de Facturación). */
export interface ContextoAuxiliares {
  terceroCode: string | null;
  centroCosto: string | null;
  flujoCajaCodigo: string | null;
}

/**
 * Attaches tercero/centroCosto/flujoCaja to every movement whose OWN account
 * carries the matching flag on the chart of accounts (design: tercero is
 * always the inmueble's unit code, never the owner's NIT; centro de costos
 * and flujo de caja are each one code per coproperty, applied uniformly to
 * every account marked for it).
 *
 * Deliberately decoupled from every builder above (`construirMovimientos`,
 * `construirAsientoCruce`, etc.) instead of threading a `cuentasPorCodigo`
 * lookup through each one's signature: every caller already has to build
 * `entries` first, so running this ONE extra pass right before
 * `this.asientos.create(...)` — same call-site shape everywhere — keeps "what
 * marks a movement with tercero/centro/flujo" in a single, independently
 * testable place. An account absent from `cuentasPorCodigo` (unconfigured, or
 * `CUENTA_SIN_ASIGNAR`) gets nothing added, same as today.
 *
 * Pure and synchronous, same reasoning as every builder above.
 */
export function enriquecerMovimientosConAuxiliares(
  movimientos: Movimiento[],
  cuentasPorCodigo: Map<string, MarcasCuentaContable>,
  contexto: ContextoAuxiliares,
): Movimiento[] {
  return movimientos.map((movimiento) => {
    const marcas = cuentasPorCodigo.get(movimiento.account);
    if (!marcas) return movimiento;
    return {
      ...movimiento,
      tercero: marcas.requiereTercero
        ? contexto.terceroCode
        : (movimiento.tercero ?? null),
      centroCosto:
        marcas.centroUtilidad || marcas.centroDestino
          ? contexto.centroCosto
          : (movimiento.centroCosto ?? null),
      flujoCaja: marcas.flujoCaja
        ? contexto.flujoCajaCodigo
        : (movimiento.flujoCaja ?? null),
    };
  });
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
  cuentaOrden: string;
  cuentaOrdenContra: string;
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
    cuentaOrden: 'Cuenta de orden — recibo de caja',
    cuentaOrdenContra:
      'Reversión de cuenta de orden — anulación de recibo de caja',
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
    cuentaOrden: 'Cuenta de orden — nota crédito',
    cuentaOrdenContra:
      'Reversión de cuenta de orden — anulación de nota crédito',
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
    cuentaOrden: 'Cuenta de orden — nota débito',
    cuentaOrdenContra:
      'Reversión de cuenta de orden — anulación de nota débito',
  },
};

/**
 * Builds the double-entry posting for a cruce document's CREATION: always
 * one debit to `cuentaOrigen` for the FULL `montoAplicado + montoSinAplicar`
 * — for a Recibo this is the bank/cash account the money arrived in; for a
 * Nota Crédito it is `cuentaDevoluciones`, the expense/contra-revenue
 * account the correction debits. The credit side splits: whatever was
 * applied in this same call goes to cartera (skipped when zero), and
 * `cuentaAnticipos` gets whatever remains unapplied (skipped when zero).
 *
 * RENAMED from `construirAsientoRecibo` (Task 2): `destinationAccount` →
 * `cuentaOrigen`, since it is not always a "destination" — for a Nota
 * Crédito nothing is received, something is corrected.
 *
 * The cartera credit is, by default, one line for `cuentaCartera` — the
 * coproperty's shared receivables account. When `desgloseCartera` is given
 * (non-empty), it REPLACES that single line with one credit per distinct
 * account in it instead — the same per-concepto coding `construirMovimientos`
 * uses for facturación, so a payment applied against a mora line credits that
 * concepto's own account, not the shared one. `cuentaCartera` is still the
 * right account for whatever `desgloseCartera` couldn't attribute (e.g. an
 * applied Nota Débito, which has no per-concepto breakdown here) — callers
 * fold that amount into the breakdown under `cuentaCartera` itself rather
 * than leaving it out, so `desgloseCartera`'s own sum always equals
 * `montoAplicado`. Anticipo (`montoSinAplicar`/`cuentaAnticipos`) is never
 * broken down: at the moment money lands unapplied it has no concepto yet.
 *
 * Structurally balanced by construction: the single debit always equals the
 * sum of the credits, since callers pass the same split that adds up to the
 * document's own total everywhere else in each service.
 *
 * `cuentasOrden`, when given, appends the same self-balancing memo pair
 * `construirMovimientos` posts for facturación — debit/credit, both for the
 * document's full `montoAplicado + montoSinAplicar`.
 */
export function construirAsientoCruce(
  cuentaOrigen: string,
  cuentaCartera: string,
  cuentaAnticipos: string,
  montoAplicado: number,
  montoSinAplicar: number,
  origen: OrigenAsiento,
  cuentasOrden?: CuentasOrden | null,
  desgloseCartera?: { account: string; monto: number }[],
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
    if (desgloseCartera && desgloseCartera.length > 0) {
      const porCuenta = new Map<string, number>();
      for (const { account, monto } of desgloseCartera) {
        if (monto === 0) continue;
        porCuenta.set(account, (porCuenta.get(account) ?? 0) + monto);
      }
      for (const [account, monto] of porCuenta) {
        movimientos.push({
          account,
          type: 'credito',
          amount: monto,
          description: d.creacionCreditoCartera,
        });
      }
    } else {
      movimientos.push({
        account: cuentaCartera,
        type: 'credito',
        amount: montoAplicado,
        description: d.creacionCreditoCartera,
      });
    }
  }
  if (montoSinAplicar > 0) {
    movimientos.push({
      account: cuentaAnticipos,
      type: 'credito',
      amount: montoSinAplicar,
      description: d.creacionCreditoAnticipo,
    });
  }

  movimientos.push(
    ...movimientosCuentasOrden(
      cuentasOrden,
      montoAplicado + montoSinAplicar,
      d.cuentaOrden,
    ),
  );

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
 *
 * `cuentasOrden`, when given, appends the reversal of the memo pair the
 * creation-time entry posted — same accounts, sides swapped (`invertido`),
 * for the full `montoOrigen` — zeroing out what `construirAsientoCruce` added
 * rather than doubling it.
 */
export function construirContraAsientoCruce(
  cuentaOrigen: string,
  cuentaCartera: string,
  cuentaAnticipos: string,
  montoAplicado: number,
  montoSinAplicar: number,
  montoOrigen: number,
  origen: OrigenAsiento,
  cuentasOrden?: CuentasOrden | null,
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

  movimientos.push(
    ...movimientosCuentasOrden(
      cuentasOrden,
      montoOrigen,
      d.cuentaOrdenContra,
      true,
    ),
  );

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
 *
 * `cuentasOrden`, when given, appends the same self-balancing memo pair as
 * every other document. There is no separate "contra" builder for a Nota
 * Contable — void calls this SAME function with `cuentaOrigen`/`cuentaDestino`
 * swapped (design §7) — so a caller voiding one must pass `cuentasOrden` with
 * `debito`/`credito` swapped too, the same way, for the memo pair to net to
 * zero instead of doubling.
 */
export function construirMovimientosReclasificacion(
  cuentaOrigen: string,
  cuentaDestino: string,
  monto: number,
  cuentasOrden?: CuentasOrden | null,
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
    ...movimientosCuentasOrden(
      cuentasOrden,
      monto,
      'Cuenta de orden — nota contable',
    ),
  ];
}

/** Swaps which account is debited/credited in a `CuentasOrden` pair — for
 *  voiding a Nota Contable, see `construirMovimientosReclasificacion`. */
export function invertirCuentasOrden(
  cuentasOrden: CuentasOrden | null,
): CuentasOrden | null {
  return cuentasOrden
    ? { debito: cuentasOrden.credito, credito: cuentasOrden.debito }
    : null;
}

/**
 * Builds the ONE consolidated reversing entry a Nota Débito's void posts.
 * Credits `cuentaCartera` (undoes the AR increase), debits `cuentaIngreso`
 * (undoes the recognized revenue) — a 2-leg reversal, simpler than Recibos'/
 * Notas Crédito's 3-leg version, since a Nota Débito has no anticipo/cash
 * concept.
 *
 * `cuentasOrden`, when given, appends the reversal (sides swapped) of the
 * memo pair `construirMovimientos` posted at creation, for the full `monto`.
 */
export function construirContraAsientoNotaDebito(
  cuentaCartera: string,
  cuentaIngreso: string,
  monto: number,
  cuentasOrden?: CuentasOrden | null,
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
    ...movimientosCuentasOrden(
      cuentasOrden,
      monto,
      'Reversión de cuenta de orden — anulación de nota débito',
      true,
    ),
  ];
}
