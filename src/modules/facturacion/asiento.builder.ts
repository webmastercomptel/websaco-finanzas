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
 * `cuentasOrden` is null, so callers can always splice the result in. Also
 * `[]` at `monto === 0` — callers that scope this to a mora-specific portion
 * (a cruce document that never touched an `intereses` concept) must not
 * leave a zero-amount debit/credit pair sitting in the ledger.
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
  if (!cuentasOrden || monto === 0) return [];
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
  requiereDocumentoCruce: boolean;
}

/** Which Factura/Nota Débito a "documento cruce" line references — `numero`
 *  is the plain sequential number (`Factura.number`/`NotaDebito.number`),
 *  never the prefixed `fullNumber`, same convention `LineaAsientoImpresion`
 *  already uses for its own `numeroDocumento`. */
export interface DocumentoCruce {
  tipo: 'FV' | 'ND';
  numero: number;
}

/** The per-transaction values `enriquecerMovimientosConAuxiliares` attaches
 *  when an account's flags call for them — the inmueble's own unit code, and
 *  the coproperty's two single auxiliary codes (Parámetros de Facturación).
 *
 *  `documentoCruce` is the UNIFORM case only — the single Factura/Nota
 *  Débito every qualifying line in THIS call's `movimientos` references (a
 *  Factura or Nota Débito self-referencing its own charge; a Nota Crédito's
 *  own creation referencing its one anchor Factura). A caller whose lines
 *  can each reference a DIFFERENT document (a Recibo settling several
 *  Facturas/Notas Débito in one entry, or a Nota Crédito's deferred
 *  `aplicar()`) sets `tipoDocumento`/`numeroDocumento` directly on each
 *  `Movimiento` itself before calling this — see the check below, which
 *  never overwrites an already-set per-línea value. */
export interface ContextoAuxiliares {
  terceroCode: string | null;
  centroCosto: string | null;
  flujoCajaCodigo: string | null;
  documentoCruce?: DocumentoCruce | null;
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
    // `?? contexto.documentoCruce` only fills in when the caller hasn't
    // already tagged this exact line with its own document (the per-línea
    // case) — never overwrites one that's already there.
    const tipoDocumento =
      movimiento.tipoDocumento ??
      (marcas.requiereDocumentoCruce
        ? (contexto.documentoCruce?.tipo ?? null)
        : null);
    const numeroDocumento =
      movimiento.numeroDocumento ??
      (marcas.requiereDocumentoCruce
        ? (contexto.documentoCruce?.numero ?? null)
        : null);
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
      tipoDocumento,
      numeroDocumento,
    };
  });
}

/**
 * Which document produced a cruce entry — Recibos ('RC'), Notas Crédito
 * ('NC'), Notas Débito ('ND'), or a Nota de Anticipo ('NA'). The ONLY thing
 * this selects is which description strings a journal line gets; every
 * account, amount and debit/credit side is computed identically regardless
 * of `origen` (design §7: "the arithmetic and shape are identical, only the
 * account and description text differ").
 */
export type OrigenAsiento = 'RC' | 'NC' | 'ND' | 'NA';

interface DescripcionesAsiento {
  creacionDebito: string;
  creacionCreditoCartera: string;
  creacionCreditoAnticipo: string;
  aplicacionDebitoAnticipo: string;
  aplicacionCreditoCartera: string;
  contraDebitoCartera: string;
  contraDebitoAnticipo: string;
  contraCredito: string;
  /** Reversal CREDIT back to `cuentaAnticipos` — only a Nota de Anticipo's
   *  void needs this: its creation DEBITS anticipos (the opposite of RC/NC,
   *  whose creation CREDITS it), so undoing it credits anticipos back
   *  instead of debiting it (`contraDebitoAnticipo`, above). Empty for
   *  every other origin, same convention as ND's unused fields. */
  contraCreditoAnticipo: string;
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
    contraCreditoAnticipo: '',
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
    contraCreditoAnticipo: '',
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
    contraCreditoAnticipo: '',
    cuentaOrden: 'Cuenta de orden — nota débito',
    cuentaOrdenContra:
      'Reversión de cuenta de orden — anulación de nota débito',
  },
  NA: {
    creacionDebito: '',
    creacionCreditoCartera: '',
    creacionCreditoAnticipo: '',
    aplicacionDebitoAnticipo: 'Anticipo aplicado a cartera — nota de anticipo',
    aplicacionCreditoCartera:
      'Cartera por cobrar — aplicación de nota de anticipo',
    contraDebitoCartera: 'Reversión de cartera — anulación de nota de anticipo',
    contraDebitoAnticipo: '',
    contraCredito: '',
    contraCreditoAnticipo:
      'Reversión de anticipo — anulación de nota de anticipo',
    cuentaOrden: 'Cuenta de orden — nota de anticipo',
    cuentaOrdenContra:
      'Reversión de cuenta de orden — anulación de nota de anticipo',
  },
};

/** One breakdown entry for `desgloseCartera`/`desgloseOrigen` below — an
 *  account, an amount, and (only for a line whose account will turn out to
 *  need one) which Factura/Nota Débito it settles. `tipoDocumento`/
 *  `numeroDocumento` are the caller's per-línea documento cruce — omit them
 *  (or pass `null`) for a line that doesn't need one; `agruparPorCuentaYDocumento`
 *  below still merges those purely by account, unchanged from before this
 *  existed. */
export interface DesgloseCuenta {
  account: string;
  monto: number;
  tipoDocumento?: 'FV' | 'ND' | null;
  numeroDocumento?: number | null;
}

/**
 * Groups a `desgloseCartera`/`desgloseOrigen` breakdown by account AND
 * documento cruce together, dropping zero-amount entries — two lines
 * against the SAME account but for DIFFERENT documents (a Recibo settling
 * two Facturas that happen to share a concepto's account) must stay two
 * separate `Movimiento` lines, never merged into one that could only carry
 * a single documento cruce. A line with no documento cruce at all — the
 * overwhelming majority, since only an account flagged
 * `requiresCrossDocument` ever carries one — still merges purely by
 * account, exactly like before this field existed.
 */
function agruparPorCuentaYDocumento(desglose: DesgloseCuenta[]): {
  account: string;
  monto: number;
  tipoDocumento: 'FV' | 'ND' | null;
  numeroDocumento: number | null;
}[] {
  const porClave = new Map<
    string,
    {
      account: string;
      monto: number;
      tipoDocumento: 'FV' | 'ND' | null;
      numeroDocumento: number | null;
    }
  >();
  for (const { account, monto, tipoDocumento, numeroDocumento } of desglose) {
    if (monto === 0) continue;
    const tipo = tipoDocumento ?? null;
    const numero = numeroDocumento ?? null;
    const clave = `${account}|${tipo ?? ''}|${numero ?? ''}`;
    const existente = porClave.get(clave);
    if (existente) {
      existente.monto += monto;
    } else {
      porClave.set(clave, {
        account,
        monto,
        tipoDocumento: tipo,
        numeroDocumento: numero,
      });
    }
  }
  return [...porClave.values()];
}

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
 * `cuentasOrden`, when given, appends the memo pair `construirMovimientos`
 * posts for facturación — SAME accounts, sides SWAPPED (`invertido: true`) —
 * for `montoCuentasOrden`: the portion of THIS call that was actually
 * applied against an `intereses` (mora) concept, never the document's whole
 * amount. Facturación opens the memo pair when the mora is invoiced (debit
 * `cuentasOrden.debito`, credit `cuentasOrden.credito`); a cruce document
 * closes it when that same mora is actually collected — reversed sides, so
 * the pair nets to zero across the two events instead of doubling. Scoped
 * the same way facturación scopes it: only a line whose own `conceptKind` is
 * `intereses` opens the pair (see `construirMovimientos`), so a cruce
 * document must mirror that scoping too, or a receipt that never touched a
 * mora charge (e.g. one paying only Administración) would still post a
 * memo entry, and one that pays BOTH mora and other concepts would post the
 * memo for more than what was actually mora. Defaults to
 * `montoAplicado + montoSinAplicar` when omitted, preserving prior callers'
 * exact behavior.
 *
 * `descuento`, when given, is an early-payment discount THIS call absorbed
 * (Recibos de Caja only, today): `montoAplicado` already carries the
 * discount summed in — it is the FULL amount credited to cartera, real cash
 * plus discount alike (see `evaluarAplicacionConDescuento`, cruce.util.ts).
 * So `cuentaOrigen`'s debit is reduced by `descuento.monto` (the real cash
 * that actually arrived), and a second debit line picks up the difference —
 * balances exactly, since debits (`cuentaOrigen` reduced + `descuento.cuenta`)
 * still sum to `montoAplicado + montoSinAplicar`, unchanged from before this
 * parameter existed.
 *
 * `desgloseOrigen`, when given (non-empty), REPLACES the single `cuentaOrigen`
 * debit with one debit per distinct account in it — mirrors `desgloseCartera`
 * on the credit side, same reasoning, opposite side. A Nota Crédito reverses
 * REVENUE, not cash like a Recibo's bank debit — the correct account to debit
 * is each concepto's own `accountingIncomeAccount` (frozen on the anchor
 * Factura's line, `ConceptoCobro.cuentaCreditoId` — the SAME account that was
 * credited when the concept was originally billed), never a single
 * coproperty-wide "cuenta de devoluciones" lumping every concept together.
 * `cuentaOrigen` remains the fallback for whatever `desgloseOrigen` couldn't
 * attribute (an unconfigured concept), same role `cuentaCartera` plays for
 * `desgloseCartera`. Never combined with `descuento` today (a Nota Crédito
 * never carries one) — if it ever is, `desgloseOrigen`'s own sum must already
 * equal `montoAplicado + montoSinAplicar - descuento.monto`, the same
 * invariant the single-account branch enforces.
 */
export function construirAsientoCruce(
  cuentaOrigen: string,
  cuentaCartera: string,
  cuentaAnticipos: string,
  montoAplicado: number,
  montoSinAplicar: number,
  origen: OrigenAsiento,
  cuentasOrden?: CuentasOrden | null,
  desgloseCartera?: DesgloseCuenta[],
  montoCuentasOrden?: number,
  descuento?: { cuenta: string; monto: number },
  desgloseOrigen?: DesgloseCuenta[],
): Movimiento[] {
  const d = DESCRIPCIONES[origen];
  const movimientos: Movimiento[] = [];
  if (desgloseOrigen && desgloseOrigen.length > 0) {
    for (const {
      account,
      monto,
      tipoDocumento,
      numeroDocumento,
    } of agruparPorCuentaYDocumento(desgloseOrigen)) {
      movimientos.push({
        account,
        type: 'debito',
        amount: monto,
        description: d.creacionDebito,
        tipoDocumento,
        numeroDocumento,
      });
    }
  } else {
    movimientos.push({
      account: cuentaOrigen,
      type: 'debito',
      amount: montoAplicado + montoSinAplicar - (descuento?.monto ?? 0),
      description: d.creacionDebito,
    });
  }
  if (descuento && descuento.monto > 0) {
    movimientos.push({
      account: descuento.cuenta,
      type: 'debito',
      amount: descuento.monto,
      description: 'Descuento por pronto pago — recibo de caja',
    });
  }

  if (montoAplicado > 0) {
    if (desgloseCartera && desgloseCartera.length > 0) {
      for (const {
        account,
        monto,
        tipoDocumento,
        numeroDocumento,
      } of agruparPorCuentaYDocumento(desgloseCartera)) {
        movimientos.push({
          account,
          type: 'credito',
          amount: monto,
          description: d.creacionCreditoCartera,
          tipoDocumento,
          numeroDocumento,
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
      montoCuentasOrden ?? montoAplicado + montoSinAplicar,
      d.cuentaOrden,
      true,
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
 *
 * `desgloseCartera` and `cuentasOrden`/`montoCuentasOrden` work exactly as
 * they do on `construirAsientoCruce` (same swapped-sides memo pair) — this is
 * the same cartera credit, only booked later instead of at creation, so a
 * deferred application against a per-concepto-coded or mora-carrying
 * document must be coded identically to an immediate one.
 */
export function construirMovimientosAplicacionAnticipo(
  cuentaAnticipos: string,
  cuentaCartera: string,
  montoAplicado: number,
  origen: OrigenAsiento,
  desgloseCartera?: DesgloseCuenta[],
  cuentasOrden?: CuentasOrden | null,
  montoCuentasOrden?: number,
): Movimiento[] {
  const d = DESCRIPCIONES[origen];
  const movimientos: Movimiento[] = [
    {
      account: cuentaAnticipos,
      type: 'debito',
      amount: montoAplicado,
      description: d.aplicacionDebitoAnticipo,
    },
  ];

  if (desgloseCartera && desgloseCartera.length > 0) {
    for (const {
      account,
      monto,
      tipoDocumento,
      numeroDocumento,
    } of agruparPorCuentaYDocumento(desgloseCartera)) {
      movimientos.push({
        account,
        type: 'credito',
        amount: monto,
        description: d.aplicacionCreditoCartera,
        tipoDocumento,
        numeroDocumento,
      });
    }
  } else {
    movimientos.push({
      account: cuentaCartera,
      type: 'credito',
      amount: montoAplicado,
      description: d.aplicacionCreditoCartera,
    });
  }

  movimientos.push(
    ...movimientosCuentasOrden(
      cuentasOrden,
      montoCuentasOrden ?? 0,
      d.cuentaOrden,
      true,
    ),
  );

  return movimientos;
}

/**
 * Builds the ONE reversing entry a Nota de Anticipo's void posts — the
 * mirror image of `construirMovimientosAplicacionAnticipo`'s own posting,
 * sides swapped: credit `cuentaAnticipos` (undoes the debit that moved the
 * anticipo out), debit each `desgloseCartera` account (undoes the credit
 * that landed on cartera), both for `montoAplicado`. Never touches a bank
 * account — a Nota de Anticipo only ever reassigns money already sitting in
 * `cuentaAnticipos`, exactly like its own creation did.
 *
 * Distinct from `construirContraAsientoCruce` (which reverses a Recibo/Nota
 * Crédito's OWN creation, always crediting back `cuentaOrigen`) because a
 * Nota de Anticipo has no `cuentaOrigen` leg to give back — undoing it only
 * ever involves the anticipo and cartera accounts.
 *
 * `cuentasOrden`, when given, reverses the memo pair the creation posted —
 * `construirMovimientosAplicacionAnticipo` already posts it INVERTED
 * relative to facturación (`invertido: true`), so undoing it goes back to
 * facturación's plain sides (`invertido: false`, the default) — same
 * reasoning as `construirContraAsientoCruce`'s own note.
 */
export function construirContraAsientoAplicacionAnticipo(
  cuentaAnticipos: string,
  cuentaCartera: string,
  montoAplicado: number,
  origen: OrigenAsiento,
  desgloseCartera?: DesgloseCuenta[],
  cuentasOrden?: CuentasOrden | null,
  montoCuentasOrden?: number,
): Movimiento[] {
  const d = DESCRIPCIONES[origen];
  const movimientos: Movimiento[] = [];

  if (desgloseCartera && desgloseCartera.length > 0) {
    for (const {
      account,
      monto,
      tipoDocumento,
      numeroDocumento,
    } of agruparPorCuentaYDocumento(desgloseCartera)) {
      movimientos.push({
        account,
        type: 'debito',
        amount: monto,
        description: d.contraDebitoCartera,
        tipoDocumento,
        numeroDocumento,
      });
    }
  } else {
    movimientos.push({
      account: cuentaCartera,
      type: 'debito',
      amount: montoAplicado,
      description: d.contraDebitoCartera,
    });
  }

  movimientos.push({
    account: cuentaAnticipos,
    type: 'credito',
    amount: montoAplicado,
    description: d.contraCreditoAnticipo,
  });

  movimientos.push(
    ...movimientosCuentasOrden(
      cuentasOrden,
      montoCuentasOrden ?? montoAplicado,
      d.cuentaOrdenContra,
    ),
  );

  return movimientos;
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
 * The `cuentaCartera` debit is, by default, one line for the coproperty's
 * shared receivables account — same default `construirAsientoCruce` uses.
 * When `desgloseCartera` is given (non-empty), it REPLACES that single line
 * with one debit per distinct account in it, restoring the SAME per-concepto
 * accounts the original creation/application actually credited, not the
 * shared one — otherwise a void would debit back an account the original
 * entry never touched, leaving both permanently unbalanced.
 *
 * `cuentasOrden`, when given, appends the reversal of the memo pair the
 * creation-time entry posted. The creation entry itself already posts
 * SWAPPED sides relative to facturación (see `construirAsientoCruce`'s own
 * note) — so undoing it must go back to facturación's original sides
 * (`invertido: false`, the plain pair), not swap them a second time. For
 * `montoCuentasOrden` (defaults to the full `montoOrigen` when omitted,
 * preserving prior callers' exact behavior) — see `construirAsientoCruce`'s
 * own note on why this must be the mora-specific portion, not the whole
 * document, whenever the caller can tell the two apart.
 *
 * `descuento`, when given, reverses the discount debit `construirAsientoCruce`
 * posted at creation: a credit back to `descuento.cuenta` for `descuento.monto`
 * (Copropiedad's `discountsCreditAccount` — the "give-back" side, distinct
 * from the debit-side account creation used). `montoAplicado` here is
 * already the full cartera amount (cash plus discount, same convention as
 * `construirAsientoCruce`), and `montoOrigen` is the Recibo's own cached
 * `receivedAmount` (real cash only) — the balance holds without any other
 * change: debits (`cuentaCartera`/`desgloseCartera` restore + `cuentaAnticipos`
 * restore) equal credits (`cuentaOrigen` for `montoOrigen` + `descuento.cuenta`
 * for `descuento.monto`), since `montoAplicado + montoSinAplicar ===
 * montoOrigen + descuento.monto` by construction.
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
  desgloseCartera?: DesgloseCuenta[],
  montoCuentasOrden?: number,
  descuento?: { cuenta: string; monto: number },
  // Mirrors `construirAsientoCruce`'s own `desgloseOrigen` — restores the
  // SAME per-concepto income accounts the creation entry actually debited,
  // not the shared `cuentaOrigen`, for the same "a void must debit back
  // exactly what was credited" reasoning `desgloseCartera`'s own docblock
  // gives.
  desgloseOrigen?: DesgloseCuenta[],
): Movimiento[] {
  const d = DESCRIPCIONES[origen];
  const movimientos: Movimiento[] = [];

  if (montoAplicado > 0) {
    if (desgloseCartera && desgloseCartera.length > 0) {
      for (const {
        account,
        monto,
        tipoDocumento,
        numeroDocumento,
      } of agruparPorCuentaYDocumento(desgloseCartera)) {
        movimientos.push({
          account,
          type: 'debito',
          amount: monto,
          description: d.contraDebitoCartera,
          tipoDocumento,
          numeroDocumento,
        });
      }
    } else {
      movimientos.push({
        account: cuentaCartera,
        type: 'debito',
        amount: montoAplicado,
        description: d.contraDebitoCartera,
      });
    }
  }
  if (montoSinAplicar > 0) {
    movimientos.push({
      account: cuentaAnticipos,
      type: 'debito',
      amount: montoSinAplicar,
      description: d.contraDebitoAnticipo,
    });
  }

  if (desgloseOrigen && desgloseOrigen.length > 0) {
    for (const {
      account,
      monto,
      tipoDocumento,
      numeroDocumento,
    } of agruparPorCuentaYDocumento(desgloseOrigen)) {
      movimientos.push({
        account,
        type: 'credito',
        amount: monto,
        description: d.contraCredito,
        tipoDocumento,
        numeroDocumento,
      });
    }
  } else {
    movimientos.push({
      account: cuentaOrigen,
      type: 'credito',
      amount: montoOrigen,
      description: d.contraCredito,
    });
  }

  if (descuento && descuento.monto > 0) {
    movimientos.push({
      account: descuento.cuenta,
      type: 'credito',
      amount: descuento.monto,
      description:
        'Reversión de descuento por pronto pago — anulación de recibo de caja',
    });
  }

  movimientos.push(
    ...movimientosCuentasOrden(
      cuentasOrden,
      montoCuentasOrden ?? montoOrigen,
      d.cuentaOrdenContra,
    ),
  );

  return movimientos;
}

/**
 * Builds the double-entry posting for a reclassification between two
 * conceptos' income accounts — a Nota Contable. Credit `cuentaOrigen`
 * (removing the balance from where it currently sits), debit `cuentaDestino`
 * (moving it to where the user wants it), both for `monto` — the same
 * polarity the cartera subsidiary ledger uses (a concepto's pending charge
 * is a receivable: crediting it reduces what the propietario owes under
 * that concepto, debiting it increases what's owed under the other one),
 * not the income-statement polarity a first reading of "cuentaCredito" might
 * suggest.
 *
 * Pure and synchronous, same discipline as every other builder function
 * here: the double-entry invariant (debits equal credits) must be
 * verifiable before anything touches the database.
 *
 * `cuentasOrden` tracks `intereses` (mora) ONLY — same rule facturación and
 * every cruce builder already enforces (`construirMovimientos`'s own
 * `usaCuentasOrden` check, `construirAsientoCruce`'s `montoCuentasOrden`).
 * `origenEsIntereses`/`destinoEsIntereses` tell this builder which side (if
 * either) is that concept, so it can move the memo pair by the right amount
 * in the right direction instead of always moving it by the FULL `monto`
 * whenever `cuentasOrden` happens to be configured — the bug this signature
 * replaces (regression: a reclassification between two non-intereses
 * concepts, e.g. Administración → Otro, was moving the memo pair anyway).
 *
 * Net effect, `netoHaciaIntereses = (destinoEsIntereses ? monto : 0) -
 * (origenEsIntereses ? monto : 0)`:
 *  - Reclassifying INTO intereses (destino only) OPENS the memo pair for
 *    `monto` — same direction `construirMovimientos` uses when mora is
 *    first invoiced (debit `cuentasOrden.debito`, credit `.credito`).
 *  - Reclassifying OUT of intereses (origen only) CLOSES it for `monto` —
 *    same reversed direction a cruce uses when mora is actually collected.
 *  - Neither side (or, degenerately, both) nets to zero: no memo movement.
 *
 * `cuentasOrden` itself is never pre-swapped by the caller: void calls this
 * SAME function with `cuentaOrigen`/`cuentaDestino` (and correspondingly
 * `origenEsIntereses`/`destinoEsIntereses`) swapped (design §7) — the sign
 * flip that produces falls straight out of `netoHaciaIntereses`, so the
 * memo pair reverses for free from the swapped roles alone. Passing an
 * already-inverted `cuentasOrden` on top (as this builder's very first
 * version required) would double-flip it back to the wrong direction.
 */
export function construirMovimientosReclasificacion(
  cuentaOrigen: string,
  cuentaDestino: string,
  monto: number,
  cuentasOrden?: CuentasOrden | null,
  origenEsIntereses = false,
  destinoEsIntereses = false,
): Movimiento[] {
  const netoHaciaIntereses =
    (destinoEsIntereses ? monto : 0) - (origenEsIntereses ? monto : 0);

  return [
    {
      account: cuentaOrigen,
      type: 'credito',
      amount: monto,
      description: 'Reclasificación de ingreso — nota contable',
    },
    {
      account: cuentaDestino,
      type: 'debito',
      amount: monto,
      description: 'Reclasificación de ingreso — nota contable',
    },
    ...(netoHaciaIntereses !== 0
      ? movimientosCuentasOrden(
          cuentasOrden,
          Math.abs(netoHaciaIntereses),
          'Cuenta de orden — nota contable',
          netoHaciaIntereses < 0,
        )
      : []),
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
