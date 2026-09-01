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
 * Splits `montoTotal` across a Factura's lines proportionally to each
 * line's `totalAmount`, and adjusts the matching SaldoCartera row for each
 * by `signo * parte` — mirroring the per-line `$inc` loop
 * `LotesFacturacionService.consolidar()` uses to build these balances in
 * the first place.
 *
 * `SaldoCartera` is a RECONCILABLE CACHE (see its schema comment), not the
 * authoritative balance — so this clamps at zero via an aggregation-pipeline
 * update instead of ever refusing the transaction: a cache that has drifted
 * low must never be the reason a real payment fails to record. `signo: 1`
 * is a void's restoration and structurally cannot go negative; `signo: -1`
 * is an application and is the one this clamp actually protects.
 *
 * Rounding: every line but the last is `Math.round()`-ed; the last absorbs
 * whatever remainder keeps the parts summing exactly to `montoTotal`.
 */
export async function ajustarSaldosCartera(
  saldos: Model<SaldoCarteraDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  factura: {
    inmuebleId: Types.ObjectId;
    total: number;
    lines: { conceptoId: Types.ObjectId; totalAmount: number }[];
  },
  montoTotal: number,
  signo: 1 | -1,
): Promise<void> {
  if (factura.lines.length === 0 || factura.total === 0 || montoTotal === 0) {
    return;
  }

  let repartido = 0;
  for (const [indice, linea] of factura.lines.entries()) {
    const esUltima = indice === factura.lines.length - 1;
    const parte = esUltima
      ? montoTotal - repartido
      : Math.round(montoTotal * (linea.totalAmount / factura.total));
    repartido += parte;
    if (parte === 0) continue;

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
 */
export async function ajustarSaldosCarteraPorDistribucion(
  saldos: Model<SaldoCarteraDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  inmuebleId: Types.ObjectId,
  distribucion: { conceptoId: Types.ObjectId; monto: number }[],
  montoAplicado: number,
  signo: 1 | -1,
): Promise<void> {
  if (distribucion.length === 0 || montoAplicado === 0) {
    return;
  }

  const sumaDistribucion = distribucion.reduce(
    (acc, linea) => acc + linea.monto,
    0,
  );
  const esAplicacionCompleta = montoAplicado === sumaDistribucion;

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
}
