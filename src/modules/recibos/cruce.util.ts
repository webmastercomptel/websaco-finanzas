// src/modules/recibos/cruce.util.ts
import { ConflictException } from '@nestjs/common';
import type { ClientSession, Model, Types } from 'mongoose';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { SaldoCarteraDocument } from '../../database/schemas/facturacion/saldo-cartera.schema';

/**
 * Raised when a Factura cannot accept the requested application — it does
 * not exist under this tenant, it is not `emitida`, or its
 * `outstandingBalance` is smaller than the amount requested (design §6,
 * "the document was voided between the user viewing it and confirming").
 * A `ConflictException` subclass on purpose: every caller can just let it
 * propagate and NestJS renders a 409 with this message, no translation step
 * needed.
 */
export class AplicacionInvalidaError extends ConflictException {
  constructor(
    public readonly facturaId: string,
    monto: number,
  ) {
    super(
      `La factura ${facturaId} no admite aplicar ${monto}: no existe, no ` +
        'está vigente, o su saldo pendiente actual es menor',
    );
  }
}

/**
 * Atomically decrements one Factura's `outstandingBalance` by `amount`,
 * inside `session`, refusing (throwing) if that would push it below zero —
 * the same `$expr`-guarded `findOneAndUpdate` discipline as
 * `NumeracionService.siguienteFactura`, applied to a decrement instead of an
 * increment.
 *
 * AUTHORITATIVE: `outstandingBalance` must never go negative, so unlike
 * `ajustarSaldosCartera` below this never clamps — a guard failure always
 * means the caller's premise (the document had enough balance) was stale,
 * and the whole transaction must abort, not retry with a smaller amount.
 *
 * `amount` itself is validated before it ever reaches the query: the $expr
 * guard only constrains the balance, not the input. A negative amount would
 * make `$gte` pass trivially and turn `$inc: -amount` into an unguarded
 * credit; a NaN amount sorts below every number in BSON comparison order, so
 * the guard would pass and `$inc` would permanently poison the authoritative
 * balance with NaN. Both must be rejected before touching the database.
 */
export async function decrementarSaldoFactura(
  facturas: Model<FacturaDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  facturaId: Types.ObjectId,
  amount: number,
): Promise<FacturaDocument> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AplicacionInvalidaError(facturaId.toString(), amount);
  }

  const actualizada = await facturas
    .findOneAndUpdate(
      {
        _id: facturaId,
        coPropertyId,
        status: 'emitida',
        // Field-to-field comparison needs $expr, same reasoning as
        // NumeracionService.siguienteFactura's range ceiling.
        $expr: { $gte: ['$outstandingBalance', amount] },
      },
      { $inc: { outstandingBalance: -amount } },
      { new: true, session },
    )
    .exec();

  if (!actualizada) {
    throw new AplicacionInvalidaError(facturaId.toString(), amount);
  }

  return actualizada;
}

/**
 * Atomically decrements one NotaDebito's `outstandingBalance` by `amount`,
 * inside `session`, refusing (throwing) if that would push it below zero —
 * sibling to `decrementarSaldoFactura`, same discipline, same $expr guard.
 *
 * A NotaDebito has a single concepto (no line array), so the
 * SaldoCartera adjustment is a single-line call — the same shape
 * `ajustarSaldosCarteraPorDistribucion` already takes with a one-element
 * `distribucion`.
 */
export async function decrementarSaldoNotaDebito(
  notasDebito: Model<NotaDebitoDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  notaDebitoId: Types.ObjectId,
  amount: number,
): Promise<NotaDebitoDocument> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AplicacionInvalidaError(notaDebitoId.toString(), amount);
  }

  const actualizada = await notasDebito
    .findOneAndUpdate(
      {
        _id: notaDebitoId,
        coPropertyId,
        status: 'emitida',
        $expr: { $gte: ['$outstandingBalance', amount] },
      },
      { $inc: { outstandingBalance: -amount } },
      { new: true, session },
    )
    .exec();

  if (!actualizada) {
    throw new AplicacionInvalidaError(notaDebitoId.toString(), amount);
  }

  return actualizada;
}

/**
 * Splits `montoTotal` across a Factura's lines as a WATERFALL, not
 * proportionally: `factura.lines` arrives sorted by each line's own
 * `ConceptoCobro.sortOrder` ASCENDING (`LotesFacturacionService.consolidar()`
 * sorts them that way before freezing the document, "Cargos order" —
 * Administración is seeded first and so normally sits at index 0). This
 * walks them in REVERSE — most-recently-created concept first — filling each
 * one's own `totalAmount` bucket completely before spilling into the next,
 * so Administración (`sortOrder` 1, almost always the oldest concept in a
 * building's Cargos table) is the LAST bucket to receive money. Business
 * rule, not a technical default: ancillary charges (parking, fines, other
 * income…) get paid off before the core administration fee does.
 *
 * Buckets are laid out on one running number line in that priority order —
 * concept N's bucket is `[cursor, cursor + N.totalAmount)` — and each call
 * only fills/drains the segment `[lo, hi)` between how much of the invoice
 * was applied BEFORE this call and how much is applied AFTER it (both
 * derived from `factura.total` and the ALREADY-UPDATED `outstandingBalance`
 * the caller passes in, post-`decrementarSaldoFactura`/post-restore). This
 * is what makes repeated partial payments against the SAME invoice correct:
 * a second payment does not re-fill a bucket a first payment already
 * finished — it resumes exactly where the running total left off. The same
 * segment math handles `signo: 1` (a void's restoration) for free: `lo`/`hi`
 * simply swap which one is "before" and which is "after".
 *
 * `SaldoCartera` is a RECONCILABLE CACHE (see its schema comment), not the
 * authoritative balance — so this clamps at zero via an aggregation-pipeline
 * update instead of ever refusing the transaction: a cache that has drifted
 * low must never be the reason a real payment fails to record.
 *
 * Returns the same per-concepto split it just applied to SaldoCartera —
 * single source of truth for "how is this amount divided among the
 * invoice's concepts", reused by the calling service to code the matching
 * journal entry per concepto instead of recomputing the split independently
 * (which would risk the two drifting apart).
 */
export async function ajustarSaldosCartera(
  saldos: Model<SaldoCarteraDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  factura: {
    inmuebleId: Types.ObjectId;
    total: number;
    outstandingBalance: number;
    lines: { conceptoId: Types.ObjectId; totalAmount: number }[];
  },
  montoTotal: number,
  signo: 1 | -1,
): Promise<{ conceptoId: Types.ObjectId; parte: number }[]> {
  if (factura.lines.length === 0 || factura.total === 0 || montoTotal === 0) {
    return [];
  }

  // How much of the invoice is applied AFTER this call vs. BEFORE it — see
  // docblock. `aplicadoDespues` uses `factura.outstandingBalance`, which the
  // caller has ALREADY updated for this call's effect.
  const aplicadoDespues = factura.total - factura.outstandingBalance;
  const aplicadoAntes = aplicadoDespues + signo * montoTotal;
  const lo = Math.min(aplicadoAntes, aplicadoDespues);
  const hi = Math.max(aplicadoAntes, aplicadoDespues);

  const ordenAplicacion = [...factura.lines].reverse();
  const partes: { conceptoId: Types.ObjectId; parte: number }[] = [];
  let cursor = 0;
  for (const linea of ordenAplicacion) {
    const inicioLinea = cursor;
    const finLinea = cursor + linea.totalAmount;
    cursor = finLinea;

    const parte = Math.max(
      0,
      Math.min(finLinea, hi) - Math.max(inicioLinea, lo),
    );
    if (parte === 0) continue;
    partes.push({ conceptoId: linea.conceptoId, parte });

    await saldos
      .findOneAndUpdate(
        {
          coPropertyId,
          inmuebleId: factura.inmuebleId,
          conceptoId: linea.conceptoId,
        },
        [
          {
            $set: {
              balance: { $max: [0, { $add: ['$balance', signo * parte] }] },
            },
          },
        ],
        { session },
      )
      .exec();
  }
  return partes;
}

/**
 * Sibling to `ajustarSaldosCartera` above, for Notas Crédito ONLY. Adjusts
 * each concepto's `SaldoCartera` by that concepto's share of the Nota
 * Crédito's own user-chosen `distribucion` — never a proportional-by-invoice-
 * line split.
 *
 * WHY THIS EXISTS AS A SEPARATE FUNCTION, NOT A CALL SITE VARIANT OF
 * `ajustarSaldosCartera`: a Recibo settles a Factura's total, so the
 * invoice's own line proportions are the only breakdown that exists — hence
 * `ajustarSaldosCartera`'s proportional split. A Nota Crédito is different:
 * its creation form asks the user to pick exactly which conceptos this
 * credit corrects and by how much, captured verbatim in
 * `NotaCredito.distribution`. That breakdown has no required relationship to
 * the anchor invoice's own line proportions (e.g. a discount aimed entirely
 * at one concepto on a multi-line invoice) — reusing the proportional split
 * would silently discard the user's explicit choice. Same clamp-at-zero
 * reasoning as `ajustarSaldosCartera`'s own docblock: `SaldoCartera` is a
 * RECONCILABLE CACHE, so this never refuses, only clamps.
 *
 * Rounding, mirrored from `ajustarSaldosCartera`: when `montoAplicado` covers
 * the distribution's full sum, each line moves by EXACTLY its own `monto` —
 * no rounding needed. When `montoAplicado` is smaller (the anticipo-
 * generating case, where the anchor invoice couldn't absorb the NC's whole
 * `montoTotal` right now), every line but the last is scaled by
 * `montoAplicado / sum(distribucion)` and `Math.round()`-ed; the last line
 * absorbs whatever remainder keeps the parts summing exactly to
 * `montoAplicado`. `montoAplicado` can never exceed `sum(distribucion)` —
 * already enforced upstream (`crear()`'s
 * `Math.min(montoTotal, factura.outstandingBalance)` plus
 * `validarDistribucionNotaCredito`'s own sum-to-`montoTotal` check) — so this
 * never guards that direction.
 *
 * Returns the same per-concepto split it just applied, same reasoning as
 * `ajustarSaldosCartera`'s own return: the caller codes the journal entry
 * per concepto from this, instead of re-deriving the rounding independently.
 */
export async function ajustarSaldosCarteraPorDistribucion(
  saldos: Model<SaldoCarteraDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  inmuebleId: Types.ObjectId,
  distribucion: { conceptoId: Types.ObjectId; monto: number }[],
  montoAplicado: number,
  signo: 1 | -1,
): Promise<{ conceptoId: Types.ObjectId; parte: number }[]> {
  if (distribucion.length === 0 || montoAplicado === 0) {
    return [];
  }

  const sumaDistribucion = distribucion.reduce(
    (acc, linea) => acc + linea.monto,
    0,
  );
  const esAplicacionCompleta = montoAplicado === sumaDistribucion;

  const partes: { conceptoId: Types.ObjectId; parte: number }[] = [];
  let repartido = 0;
  for (const [indice, linea] of distribucion.entries()) {
    const esUltima = indice === distribucion.length - 1;
    const parte = esAplicacionCompleta
      ? linea.monto
      : esUltima
        ? montoAplicado - repartido
        : Math.round(montoAplicado * (linea.monto / sumaDistribucion));
    repartido += parte;
    if (parte === 0) continue;
    partes.push({ conceptoId: linea.conceptoId, parte });

    await saldos
      .findOneAndUpdate(
        {
          coPropertyId,
          inmuebleId,
          conceptoId: linea.conceptoId,
        },
        [
          {
            $set: {
              balance: { $max: [0, { $add: ['$balance', signo * parte] }] },
            },
          },
        ],
        { session },
      )
      .exec();
  }
  return partes;
}
