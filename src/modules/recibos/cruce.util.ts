// src/modules/recibos/cruce.util.ts
import { ConflictException } from '@nestjs/common';
import type { ClientSession, Model, Types } from 'mongoose';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
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
 */
export async function decrementarSaldoFactura(
  facturas: Model<FacturaDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  facturaId: Types.ObjectId,
  amount: number,
): Promise<FacturaDocument> {
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
