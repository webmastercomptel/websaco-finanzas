// src/modules/recibos/cruce.util.ts
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { ClientSession, Model } from 'mongoose';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { SaldoCarteraDocument } from '../../database/schemas/facturacion/saldo-cartera.schema';
import type { CarteraPorDocumentoDocument } from '../../database/schemas/facturacion/cartera-por-documento.schema';
import type { SaldoTotalDocumentoDocument } from '../../database/schemas/facturacion/saldo-total-documento.schema';
import type { DocumentType } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { ErrorAplicacion } from '../../contracts';
import type { AplicacionSolicitadaDto } from './dto/aplicacion-solicitada.dto';

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

/** A Factura/NotaDebito Mongoose document, plus its CURRENT total pending
 *  balance resolved from `SaldoTotalDocumento` — never a real field on the
 *  document itself anymore (see that schema's own docblock on why the
 *  atomic guard had to move off the immutable document). Every caller that
 *  used to read `.outstandingBalance` straight off the Mongoose result
 *  keeps working unchanged against this shape. */
type ConSaldoPendiente<T> = T & { outstandingBalance: number };

/**
 * Atomically decrements one Factura's `SaldoTotalDocumento` row by `amount`,
 * inside `session`, refusing (throwing) if that would push it below zero —
 * the same `$expr`-guarded `findOneAndUpdate` discipline as
 * `NumeracionService.siguienteFactura`, applied to a decrement instead of an
 * increment. See `SaldoTotalDocumento`'s own docblock for why this guard
 * lives in its own collection instead of summing `CarteraPorDocumento`'s
 * per-concepto rows on the fly: only a single atomically-guarded field can
 * refuse an over-application; N separately-updated rows cannot.
 *
 * AUTHORITATIVE: this balance must never go negative, so unlike
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
 *
 * Reads the Factura itself (immutable, so a plain `findOne` after the guard
 * already passed is safe — its `lines`/`total`/`inmuebleId` never change) to
 * return everything a caller needs in one shape, `outstandingBalance`
 * included, so `ajustarSaldosCartera`/`resumen` builders elsewhere need no
 * changes of their own.
 */
export async function decrementarSaldoFactura(
  facturas: Model<FacturaDocument>,
  saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  facturaId: Types.ObjectId,
  amount: number,
): Promise<ConSaldoPendiente<FacturaDocument>> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AplicacionInvalidaError(facturaId.toString(), amount);
  }

  const saldoActualizado = await saldoTotalDocumento
    .findOneAndUpdate(
      {
        documentoId: facturaId,
        // Field-to-field comparison needs $expr, same reasoning as
        // NumeracionService.siguienteFactura's range ceiling.
        $expr: { $gte: ['$saldoPendiente', amount] },
      },
      { $inc: { saldoPendiente: -amount } },
      { returnDocument: 'after', session },
    )
    .exec();

  if (!saldoActualizado) {
    throw new AplicacionInvalidaError(facturaId.toString(), amount);
  }

  const factura = await facturas
    .findOne({ _id: facturaId, coPropertyId, status: 'emitida' })
    .session(session)
    .exec();
  if (!factura) {
    throw new AplicacionInvalidaError(facturaId.toString(), amount);
  }

  return Object.assign(factura, {
    outstandingBalance: saldoActualizado.saldoPendiente,
  });
}

/**
 * Atomically decrements one NotaDebito's `SaldoTotalDocumento` row by
 * `amount`, inside `session`, refusing (throwing) if that would push it
 * below zero — sibling to `decrementarSaldoFactura`, same discipline, same
 * $expr guard, same reason the guard lives off the document itself.
 *
 * A NotaDebito has a single concepto (no line array), so the
 * SaldoCartera adjustment is a single-line call — the same shape
 * `ajustarSaldosCarteraPorDistribucion` already takes with a one-element
 * `distribucion`.
 */
export async function decrementarSaldoNotaDebito(
  notasDebito: Model<NotaDebitoDocument>,
  saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  notaDebitoId: Types.ObjectId,
  amount: number,
): Promise<ConSaldoPendiente<NotaDebitoDocument>> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AplicacionInvalidaError(notaDebitoId.toString(), amount);
  }

  const saldoActualizado = await saldoTotalDocumento
    .findOneAndUpdate(
      {
        documentoId: notaDebitoId,
        $expr: { $gte: ['$saldoPendiente', amount] },
      },
      { $inc: { saldoPendiente: -amount } },
      { returnDocument: 'after', session },
    )
    .exec();

  if (!saldoActualizado) {
    throw new AplicacionInvalidaError(notaDebitoId.toString(), amount);
  }

  const notaDebito = await notasDebito
    .findOne({ _id: notaDebitoId, coPropertyId, status: 'emitida' })
    .session(session)
    .exec();
  if (!notaDebito) {
    throw new AplicacionInvalidaError(notaDebitoId.toString(), amount);
  }

  return Object.assign(notaDebito, {
    outstandingBalance: saldoActualizado.saldoPendiente,
  });
}

/**
 * Atomically restores (increments) one document's `SaldoTotalDocumento` row
 * by `amount` — the reversal counterpart to `decrementarSaldoFactura`/
 * `decrementarSaldoNotaDebito`, used by every `anular()` that used to
 * `$inc: { outstandingBalance: +amount }` straight on the Factura/NotaDebito.
 * Unconditional, no `$expr` guard: a reversal only ever adds back money that
 * a prior successful decrement already proved was there — never a floor to
 * enforce, same reasoning `RecibosService.anular()`'s own comment already
 * gave for the plain `$inc` it used to do directly.
 */
export async function restaurarSaldoTotalDocumento(
  saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
  session: ClientSession,
  documentoId: Types.ObjectId,
  amount: number,
): Promise<SaldoTotalDocumentoDocument | null> {
  return saldoTotalDocumento
    .findOneAndUpdate(
      { documentoId },
      { $inc: { saldoPendiente: amount } },
      { returnDocument: 'after', session },
    )
    .exec();
}

/**
 * Adjusts one `CarteraPorDocumento` row's `saldoPendiente` — the per-document
 * twin of the `$max`/`$add` pipeline update `ajustarSaldosCartera`/
 * `ajustarSaldosCarteraPorDistribucion` already run against `SaldoCartera`,
 * extracted so both can call it once per concepto part instead of
 * duplicating the pipeline shape. Same clamp-at-zero reasoning: fed by the
 * exact same `parte` these functions just computed for the cross-document
 * aggregate, so it should never actually hit the floor in practice, but a
 * per-document row is no less a target for drift than the aggregate is.
 */
async function ajustarCarteraPorDocumento(
  carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
  session: ClientSession,
  documentoId: Types.ObjectId,
  conceptoId: Types.ObjectId,
  parte: number,
  signo: 1 | -1,
): Promise<void> {
  await carteraPorDocumento
    .findOneAndUpdate(
      { documentoId, conceptoId },
      [
        {
          $set: {
            saldoPendiente: {
              $max: [0, { $add: ['$saldoPendiente', signo * parte] }],
            },
          },
        },
      ],
      { session, updatePipeline: true },
    )
    .exec();
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
  carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  factura: {
    _id: Types.ObjectId;
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
        // Mongoose 9 refuses an array update (an aggregation pipeline, needed
        // here for `$max`/`$add` against the document's OWN current value)
        // unless this is set explicitly — it used to infer this from the
        // array shape alone.
        { session, updatePipeline: true },
      )
      .exec();
    await ajustarCarteraPorDocumento(
      carteraPorDocumento,
      session,
      factura._id,
      linea.conceptoId,
      parte,
      signo,
    );
  }
  return partes;
}

/**
 * How much of each of a Factura's own lines is CURRENTLY pending — the
 * number a user-chosen manual distribution is validated against (never the
 * frozen `totalAmount`, unlike `validarDistribucionNotaCredito`'s own cap: a
 * Nota Crédito typically runs against a still-fresh invoice, but a Recibo's
 * manual application can run against one already partly paid down).
 *
 * Resolved per LINE, independently: a line already carrying a real
 * `remainingAmount` (written by a prior manual distribution against this
 * same factura — see `ejecutarAplicacionManual`) reports that value
 * directly; a line that has never been touched that way (`remainingAmount`
 * still `null`, true for every factura issued before this field existed, and
 * for any of THIS factura's lines a manual distribution never targeted)
 * derives it from `factura.total`/`outstandingBalance` via the SAME reverse-
 * order cascade `ajustarSaldosCartera` above has always used — the only
 * order any of its own money could ever have drained through until now, so
 * this reproduces exactly what that line's true remainder is.
 *
 * Deliberately does NOT require every line to be in the same state (all
 * tracked or all derived) — a factura can have some lines already migrated
 * by an earlier manual distribution and others still legacy, and each is
 * resolved on its own.
 */
export function remanentesPorLinea(factura: {
  total: number;
  outstandingBalance: number;
  lines: {
    conceptoId: Types.ObjectId;
    totalAmount: number;
    remainingAmount?: number | null;
  }[];
}): Map<string, number> {
  const aplicado = factura.total - factura.outstandingBalance;
  const ordenAplicacion = [...factura.lines].reverse();
  const resultado = new Map<string, number>();
  let cursor = 0;
  for (const linea of ordenAplicacion) {
    const inicioLinea = cursor;
    const finLinea = cursor + linea.totalAmount;
    cursor = finLinea;

    if (linea.remainingAmount != null) {
      resultado.set(linea.conceptoId.toString(), linea.remainingAmount);
      continue;
    }
    const pagado = Math.max(0, Math.min(finLinea, aplicado) - inicioLinea);
    resultado.set(linea.conceptoId.toString(), linea.totalAmount - pagado);
  }
  return resultado;
}

/**
 * Validates a Recibo's requested manual `distribucion` against its target
 * invoice's OWN currently pending balance per concepto (`remanentesPorLinea`
 * above): the distribution must sum to EXACTLY `montoAplicado`, and no line
 * may ask for more than that concepto's own remainder — asking for LESS is
 * always fine (that concepto simply stays partly pending, same as any
 * ordinary partial abono). Mirrors `validarDistribucionNotaCredito`'s
 * error style; never partially applies — the caller runs this before
 * touching the database.
 */
export function validarDistribucionManual(
  distribucion: { conceptoId: string; monto: number }[],
  montoAplicado: number,
  remanentes: Map<string, number>,
): void {
  const suma = distribucion.reduce((acc, linea) => acc + linea.monto, 0);
  if (suma !== montoAplicado) {
    throw new ConflictException(
      `El reparto por concepto (${suma}) no coincide con el monto a aplicar (${montoAplicado})`,
    );
  }

  for (const linea of distribucion) {
    const remanente = remanentes.get(linea.conceptoId) ?? 0;
    if (linea.monto > remanente) {
      throw new ConflictException(
        `El concepto ${linea.conceptoId} no admite aplicar ${linea.monto}: ` +
          `su saldo pendiente en esta factura es ${remanente}`,
      );
    }
  }
}

/**
 * Persists this factura's per-línea `remainingAmount` after a manual
 * distribution touched it — one targeted `$set` per línea (never `$inc`: a
 * line still at its `null` default has nothing numeric to increment from,
 * and the caller already knows the exact new value from
 * `remanentesPorLinea`'s own read). Used both going forward (a manual
 * distribution decrements) and in reverse (an anulación restores) — the
 * caller computes `nuevoValor` either way, this just writes it.
 */
export async function actualizarRemanentesLinea(
  facturas: Model<FacturaDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  facturaId: Types.ObjectId,
  cambios: { conceptoId: Types.ObjectId; nuevoValor: number }[],
): Promise<void> {
  for (const cambio of cambios) {
    await facturas
      .updateOne(
        {
          _id: facturaId,
          coPropertyId,
          'lines.conceptoId': cambio.conceptoId,
        },
        { $set: { 'lines.$.remainingAmount': cambio.nuevoValor } },
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
 *
 * Returns the same per-concepto split it just applied, same reasoning as
 * `ajustarSaldosCartera`'s own return: the caller codes the journal entry
 * per concepto from this, instead of re-deriving the rounding independently.
 */
export async function ajustarSaldosCarteraPorDistribucion(
  saldos: Model<SaldoCarteraDocument>,
  carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
  session: ClientSession,
  coPropertyId: Types.ObjectId,
  inmuebleId: Types.ObjectId,
  distribucion: { conceptoId: Types.ObjectId; monto: number }[],
  montoAplicado: number,
  signo: 1 | -1,
  // The document this distribution actually belongs to — omitted only by
  // `NotasContablesService`, whose reclassification is scoped to a whole
  // inmueble+concepto, not one document (see `CarteraPorDocumento`'s own
  // docblock; which specific document(s) a reclasificación should land on
  // is still an open design question, tracked separately). Every OTHER
  // caller has a concrete anchor document and must pass this.
  documento?: { tipoDocumento: DocumentType; documentoId: Types.ObjectId },
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
        // See the identical note in `ajustarSaldosCartera` above.
        { session, updatePipeline: true },
      )
      .exec();
    if (documento) {
      await ajustarCarteraPorDocumento(
        carteraPorDocumento,
        session,
        documento.documentoId,
        linea.conceptoId,
        parte,
        signo,
      );
    }
  }
  return partes;
}

/**
 * One applied document's outcome, as needed to redact a Recibo's
 * Observaciones automatically ("Cancela factura 6, 173" / "Abona a factura
 * 340") — `numero` is the document's bare number (never `fullNumber`, which
 * carries the "FV-"/"ND-" prefix the redacted text doesn't want), `completa`
 * is whether THIS application brought the document's `outstandingBalance`
 * to exactly zero (a partial application never can, since
 * `decrementarSaldoFactura`/`decrementarSaldoNotaDebito` refuse to go
 * negative — `=== 0` is unambiguous, no epsilon needed).
 */
export type ResumenAplicacion = {
  tipo: 'FV' | 'ND';
  numero: number;
  completa: boolean;
};

/** `montoAFactura` — how much to actually decrement/credit for this
 *  document: its full `outstandingBalance` when the discount activates,
 *  otherwise `montoDisponible` VERBATIM, uncapped — the caller decides
 *  whether/how to cap that (see this function's own docblock on why).
 *  `montoDescuento` is the portion of that which is discount, not real
 *  money (0 when it didn't activate). */
export interface ResultadoElegibilidadDescuento {
  montoAFactura: number;
  montoDescuento: number;
}

/**
 * The single place the early-payment-discount business rule lives, shared
 * by `ejecutarAplicacionFifo` and `ejecutarAplicacionManual` — a document
 * only ever earns its own `discountAmount` when paying it off COMPLETELY,
 * never prorated onto a partial abono (confirmed with product: "debe
 * pagarla totalmente"). Never called for a Nota Débito target — those never
 * carry a discount, so both callers skip straight to their own plain path
 * for that branch.
 *
 * Deliberately does NOT cap the "didn't activate" branch to
 * `outstandingBalance` — `ejecutarAplicacionFifo` needs that cap (FIFO always
 * bounds itself to what a document can accept), but `ejecutarAplicacionManual`
 * must NOT: capping there would silently shrink a caller's over-large
 * request instead of letting `decrementarSaldoFactura`'s own `$expr` guard
 * reject it with the `ConflictException` a manual all-or-nothing request is
 * supposed to get. So this returns `montoDisponible` untouched here; FIFO
 * applies its own `Math.min` on the result.
 *
 * `factura.discountAmount` is capped to `outstandingBalance` defensively —
 * a discount larger than what's actually owed (a misconfigured Parámetros
 * value, or a partial payment already landed between consolidación and
 * this Recibo) must never let `montoAFactura - montoDescuento` (the real
 * cash drawn) go negative.
 */
export function evaluarAplicacionConDescuento(
  factura: {
    outstandingBalance: number;
    discountAmount: number;
    discountDeadline: Date | null;
  },
  fechaRecibo: Date,
  montoDisponible: number,
): ResultadoElegibilidadDescuento {
  const descuentoOfrecido = Math.min(
    factura.discountAmount,
    factura.outstandingBalance,
  );
  const dentroDePlazo =
    descuentoOfrecido > 0 &&
    factura.discountDeadline !== null &&
    fechaRecibo.getTime() <= factura.discountDeadline.getTime();

  if (
    dentroDePlazo &&
    montoDisponible + descuentoOfrecido >= factura.outstandingBalance
  ) {
    return {
      montoAFactura: factura.outstandingBalance,
      montoDescuento: descuentoOfrecido,
    };
  }
  return { montoAFactura: montoDisponible, montoDescuento: 0 };
}

/**
 * Shared context every cruce-execution call needs — models, the session,
 * and WHO this application event is (`sourceType`/`sourceId`), always
 * anchored to the Recibo whose `unappliedAmount` is being drawn down.
 *
 * `recibo` is always the source of the money, whether the caller is
 * `RecibosService` (applying at creation or, historically, right after —
 * `sourceType: 'RC'`, `sourceId: recibo._id`) or `NotasAnticipoService`
 * (applying a Recibo's LEFTOVER anticipo later, as its own document —
 * `sourceType: 'NA'`, `sourceId` the new Nota de Anticipo's `_id`). Either
 * way, the balance that actually decreases is the Recibo's own
 * `unappliedAmount` — a Nota de Anticipo has no running balance of its
 * own, it is one complete record of a single application event.
 */
export interface ContextoAplicacion {
  facturas: Model<FacturaDocument>;
  notasDebito: Model<NotaDebitoDocument>;
  aplicaciones: Model<AplicacionCarteraDocument>;
  saldos: Model<SaldoCarteraDocument>;
  carteraPorDocumento: Model<CarteraPorDocumentoDocument>;
  saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>;
  recibos: Model<ReciboDocument>;
  session: ClientSession;
  coPropertyId: Types.ObjectId;
  recibo: ReciboDocument;
  sourceType: 'RC' | 'NA';
  sourceId: Types.ObjectId;
  accountId: string;
}

/**
 * Applies `solicitadas` against their documents — ALL of them, or none: if
 * the sum exceeds `ctx.recibo.unappliedAmount`, or any single line's
 * `decrementarSaldoFactura` call throws, the whole transaction aborts
 * (manual application mode is all-or-nothing).
 *
 * Extracted from `RecibosService.aplicarManual` (formerly private, formerly
 * hardcoded to `sourceType: 'RC'`) so `NotasAnticipoService` can run the
 * exact same logic against the exact same Recibo balance, just recorded
 * under a Nota de Anticipo instead. Both `RecibosService.aplicarManual` and
 * `NotasAnticipoService.crear()` are now thin wrappers around this.
 */
export async function ejecutarAplicacionManual(
  ctx: ContextoAplicacion,
  solicitadas: AplicacionSolicitadaDto[],
): Promise<{
  creadas: AplicacionCarteraDocument[];
  creditosPorCuenta: Map<string | null, number>;
  montoAplicadoMora: number;
  resumen: ResumenAplicacion[];
  montoDescuentoTotal: number;
}> {
  const {
    facturas,
    notasDebito,
    aplicaciones,
    saldos,
    carteraPorDocumento,
    saldoTotalDocumento,
    recibos,
    session,
    coPropertyId,
    recibo,
    sourceType,
    sourceId,
    accountId,
  } = ctx;

  const sumaSolicitada = solicitadas.reduce(
    (acc, a) => acc + a.montoAplicado,
    0,
  );
  if (sumaSolicitada > recibo.unappliedAmount) {
    throw new ConflictException(
      `La suma solicitada (${sumaSolicitada}) supera el saldo sin aplicar ` +
        `del recibo ${recibo.fullNumber} (${recibo.unappliedAmount})`,
    );
  }

  const creadas: AplicacionCarteraDocument[] = [];
  const creditosPorCuenta = new Map<string | null, number>();
  const acumular = (cuenta: string | null, monto: number) => {
    if (monto === 0) return;
    creditosPorCuenta.set(cuenta, (creditosPorCuenta.get(cuenta) ?? 0) + monto);
  };
  let montoAplicadoMora = 0;
  let montoDescuentoTotal = 0;
  let sumaCashAplicada = 0;
  const resumen: ResumenAplicacion[] = [];

  for (const solicitada of solicitadas) {
    const documentoId = new Types.ObjectId(solicitada.documentoId);

    if (solicitada.tipoDocumento === 'ND') {
      if (solicitada.distribucion?.length) {
        throw new BadRequestException(
          'No se puede repartir por concepto una aplicación contra una ' +
            'Nota Débito — tiene un solo concepto.',
        );
      }
      const notaDebito = await decrementarSaldoNotaDebito(
        notasDebito,
        saldoTotalDocumento,
        session,
        coPropertyId,
        documentoId,
        solicitada.montoAplicado,
      );

      if (!notaDebito.inmuebleId.equals(recibo.inmuebleId)) {
        throw new ConflictException(
          `La nota débito ${documentoId.toString()} pertenece a otro ` +
            `inmueble (${notaDebito.inmuebleId.toString()}) que el recibo ` +
            `${recibo.fullNumber} (${recibo.inmuebleId.toString()})`,
        );
      }

      await ajustarSaldosCarteraPorDistribucion(
        saldos,
        carteraPorDocumento,
        session,
        coPropertyId,
        notaDebito.inmuebleId,
        [{ conceptoId: notaDebito.conceptoId, monto: notaDebito.total }],
        solicitada.montoAplicado,
        -1,
        { tipoDocumento: 'ND', documentoId: notaDebito._id },
      );
      acumular(null, solicitada.montoAplicado);
      sumaCashAplicada += solicitada.montoAplicado;

      const [creada] = await aplicaciones.create(
        [
          {
            coPropertyId,
            sourceType,
            sourceId,
            documentType: 'ND',
            documentId: documentoId,
            amountApplied: solicitada.montoAplicado,
            discountApplied: 0,
            detalleConceptos: [
              {
                conceptoId: notaDebito.conceptoId,
                conceptName: notaDebito.description ?? 'Nota Débito',
                monto: solicitada.montoAplicado,
              },
            ],
            status: 'activa',
            appliedAt: new Date(),
            appliedBy: accountId,
          },
        ],
        { session },
      );
      creadas.push(creada);
      resumen.push({
        tipo: 'ND',
        numero: notaDebito.number,
        completa: notaDebito.outstandingBalance === 0,
      });
      continue;
    }

    // Read-before-write: `evaluarAplicacionConDescuento` needs the
    // PRE-decrement `outstandingBalance` to decide whether this payment,
    // plus the invoice's own discount, covers it completely — the atomic
    // `decrementarSaldoFactura` below still guards the actual write with
    // its own `$expr`, so a stale read here just means that guard throws
    // (same failure mode as today), never a lost update.
    const facturaActual = await facturas
      .findOne({ _id: documentoId, coPropertyId, status: 'emitida' })
      .session(session)
      .exec();
    if (!facturaActual) {
      throw new AplicacionInvalidaError(
        documentoId.toString(),
        solicitada.montoAplicado,
      );
    }
    // El usuario tomó control explícito del reparto por concepto — validado
    // contra el saldo pendiente REAL de cada concepto de esta factura (nunca
    // contra su totalAmount congelado, a diferencia de una Nota Crédito: esta
    // factura puede ya venir parcialmente pagada). El descuento por pronto
    // pago se omite en este caso — solo tiene sentido en la vía automática,
    // donde saldar la factura completa lo activa; aquí el usuario ya decidió
    // exactamente qué se paga.
    const repartoElegido = solicitada.distribucion?.length
      ? solicitada.distribucion
      : null;
    const remanentesAntes = remanentesPorLinea(facturaActual);
    let montoAFactura: number;
    let montoDescuento: number;
    if (repartoElegido) {
      validarDistribucionManual(
        repartoElegido,
        solicitada.montoAplicado,
        remanentesAntes,
      );
      montoAFactura = solicitada.montoAplicado;
      montoDescuento = 0;
    } else {
      ({ montoAFactura, montoDescuento } = evaluarAplicacionConDescuento(
        facturaActual,
        recibo.receivedDate,
        solicitada.montoAplicado,
      ));
    }

    const factura = await decrementarSaldoFactura(
      facturas,
      saldoTotalDocumento,
      session,
      coPropertyId,
      documentoId,
      montoAFactura,
    );

    if (!factura.inmuebleId.equals(recibo.inmuebleId)) {
      throw new ConflictException(
        `La factura ${documentoId.toString()} pertenece a otro inmueble ` +
          `(${factura.inmuebleId.toString()}) que el recibo ` +
          `${recibo.fullNumber} (${recibo.inmuebleId.toString()})`,
      );
    }

    const partes = repartoElegido
      ? await ajustarSaldosCarteraPorDistribucion(
          saldos,
          carteraPorDocumento,
          session,
          coPropertyId,
          factura.inmuebleId,
          repartoElegido.map((l) => ({
            conceptoId: new Types.ObjectId(l.conceptoId),
            monto: l.monto,
          })),
          montoAFactura,
          -1,
          { tipoDocumento: 'FV', documentoId: factura._id },
        )
      : await ajustarSaldosCartera(
          saldos,
          carteraPorDocumento,
          session,
          coPropertyId,
          factura,
          montoAFactura,
          -1,
        );

    if (repartoElegido) {
      await actualizarRemanentesLinea(
        facturas,
        session,
        coPropertyId,
        factura._id,
        partes.map((parte) => ({
          conceptoId: parte.conceptoId,
          nuevoValor:
            (remanentesAntes.get(parte.conceptoId.toString()) ?? 0) -
            parte.parte,
        })),
      );
    }

    const detalleConceptos = partes.map((parte) => {
      const linea = factura.lines.find((l) =>
        l.conceptoId.equals(parte.conceptoId),
      );
      return {
        conceptoId: parte.conceptoId,
        conceptName: linea?.conceptName ?? 'Concepto',
        monto: parte.parte,
      };
    });
    for (const parte of partes) {
      const linea = factura.lines.find((l) =>
        l.conceptoId.equals(parte.conceptoId),
      );
      acumular(linea?.accountingReceivableAccount ?? null, parte.parte);
      if (linea?.conceptKind === 'intereses') {
        montoAplicadoMora += parte.parte;
      }
    }
    montoDescuentoTotal += montoDescuento;
    sumaCashAplicada += montoAFactura - montoDescuento;

    const [creada] = await aplicaciones.create(
      [
        {
          coPropertyId,
          sourceType,
          sourceId,
          documentType: 'FV',
          documentId: documentoId,
          amountApplied: montoAFactura,
          discountApplied: montoDescuento,
          detalleConceptos,
          status: 'activa',
          appliedAt: new Date(),
          appliedBy: accountId,
        },
      ],
      { session },
    );
    creadas.push(creada);
    resumen.push({
      tipo: 'FV',
      numero: factura.number,
      completa: factura.outstandingBalance === 0,
    });
  }

  await recibos
    .findOneAndUpdate(
      { _id: recibo._id, coPropertyId },
      {
        $inc: {
          appliedAmount: sumaCashAplicada,
          unappliedAmount: -sumaCashAplicada,
        },
      },
      { session },
    )
    .exec();

  return {
    creadas,
    creditosPorCuenta,
    montoAplicadoMora,
    resumen,
    montoDescuentoTotal,
  };
}

/**
 * Walks the inmueble's open Facturas AND open Notas Débito, merged into one
 * oldest-first queue, applying until `montoDisponible` is exhausted or there
 * is nothing left open — stopping partway through is the expected outcome
 * (FIFO automatic mode is best-effort), not an error. A document that turns
 * out invalid since the list was built (voided, or someone else just
 * exhausted its balance in this same transaction) is skipped and reported
 * in `errores`, never a hard failure of the whole call.
 *
 * Extracted from `RecibosService.aplicarFifo` — see `ejecutarAplicacionManual`'s
 * own note on why, and on what `ctx.recibo`/`ctx.sourceType`/`ctx.sourceId`
 * mean here.
 */
export async function ejecutarAplicacionFifo(
  ctx: ContextoAplicacion,
  montoDisponible: number,
): Promise<{
  aplicadas: AplicacionCarteraDocument[];
  errores: ErrorAplicacion[];
  montoSinAplicar: number;
  creditosPorCuenta: Map<string | null, number>;
  montoAplicadoMora: number;
  resumen: ResumenAplicacion[];
  montoDescuentoTotal: number;
}> {
  const {
    facturas,
    notasDebito,
    aplicaciones,
    saldos,
    carteraPorDocumento,
    saldoTotalDocumento,
    recibos,
    session,
    coPropertyId,
    recibo,
    sourceType,
    sourceId,
    accountId,
  } = ctx;

  // Candidate documents are bounded to this ONE inmueble (a small set) —
  // fetched first, THEN cross-referenced against `SaldoTotalDocumento` for
  // which still have a positive balance, instead of a field filter that no
  // longer exists on the (now immutable) Factura/NotaDebito documents.
  const [facturasDelInmueble, notasDebitoDelInmueble] = await Promise.all([
    facturas
      .find({ coPropertyId, inmuebleId: recibo.inmuebleId, status: 'emitida' })
      .session(session)
      .exec(),
    notasDebito
      .find({ coPropertyId, inmuebleId: recibo.inmuebleId, status: 'emitida' })
      .session(session)
      .exec(),
  ]);
  const idsDelInmueble = [
    ...facturasDelInmueble.map((f) => f._id),
    ...notasDebitoDelInmueble.map((n) => n._id),
  ];
  const saldosTotales = idsDelInmueble.length
    ? await saldoTotalDocumento
        .find({ documentoId: { $in: idsDelInmueble }, saldoPendiente: { $gt: 0 } })
        .session(session)
        .exec()
    : [];
  const saldoPorDocumento = new Map(
    saldosTotales.map((s) => [s.documentoId.toString(), s.saldoPendiente]),
  );
  const facturasAbiertas = facturasDelInmueble
    .filter((f) => saldoPorDocumento.has(f._id.toString()))
    .sort(
      (a, b) =>
        (a.dueDate ?? a.issueDate).getTime() -
        (b.dueDate ?? b.issueDate).getTime(),
    );
  const notasDebitoAbiertas = notasDebitoDelInmueble
    .filter((n) => saldoPorDocumento.has(n._id.toString()))
    .sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime());

  type Candidato =
    | {
        tipo: 'FV';
        doc: FacturaDocument;
        saldoPendiente: number;
        prioridad: Date;
      }
    | {
        tipo: 'ND';
        doc: NotaDebitoDocument;
        saldoPendiente: number;
        prioridad: Date;
      };

  const abiertas: Candidato[] = [
    ...facturasAbiertas.map(
      (factura): Candidato => ({
        tipo: 'FV',
        doc: factura,
        saldoPendiente: saldoPorDocumento.get(factura._id.toString())!,
        prioridad: factura.dueDate ?? factura.issueDate,
      }),
    ),
    ...notasDebitoAbiertas.map(
      (nota): Candidato => ({
        tipo: 'ND',
        doc: nota,
        saldoPendiente: saldoPorDocumento.get(nota._id.toString())!,
        prioridad: nota.issueDate,
      }),
    ),
  ].sort((a, b) => {
    const porFecha = a.prioridad.getTime() - b.prioridad.getTime();
    if (porFecha !== 0) return porFecha;
    return a.doc._id.toString().localeCompare(b.doc._id.toString());
  });

  const aplicadas: AplicacionCarteraDocument[] = [];
  const errores: ErrorAplicacion[] = [];
  const creditosPorCuenta = new Map<string | null, number>();
  const acumular = (cuenta: string | null, valor: number) => {
    if (valor === 0) return;
    creditosPorCuenta.set(cuenta, (creditosPorCuenta.get(cuenta) ?? 0) + valor);
  };
  let restante = montoDisponible;
  let totalAplicado = 0;
  let montoAplicadoMora = 0;
  let montoDescuentoTotal = 0;
  const resumen: ResumenAplicacion[] = [];

  for (const candidato of abiertas) {
    if (restante <= 0) break;
    // Notas Débito never carry a discount — only a Factura candidate goes
    // through `evaluarAplicacionConDescuento`. FIFO always caps to what the
    // candidate can accept, whether or not the discount activated (that
    // function deliberately leaves the "didn't activate" branch uncapped —
    // see its own docblock; capping is this caller's job, not shared with
    // `ejecutarAplicacionManual`, which must NOT cap).
    const { montoAFactura: montoSinCapar, montoDescuento } =
      candidato.tipo === 'FV'
        ? evaluarAplicacionConDescuento(
            {
              outstandingBalance: candidato.saldoPendiente,
              discountAmount: candidato.doc.discountAmount,
              discountDeadline: candidato.doc.discountDeadline,
            },
            recibo.receivedDate,
            restante,
          )
        : { montoAFactura: restante, montoDescuento: 0 };
    const monto = Math.min(montoSinCapar, candidato.saldoPendiente);
    const cashUsado = monto - montoDescuento;

    try {
      if (candidato.tipo === 'ND') {
        const notaActualizada = await decrementarSaldoNotaDebito(
          notasDebito,
          saldoTotalDocumento,
          session,
          coPropertyId,
          candidato.doc._id,
          monto,
        );

        await ajustarSaldosCarteraPorDistribucion(
          saldos,
          carteraPorDocumento,
          session,
          coPropertyId,
          notaActualizada.inmuebleId,
          [
            {
              conceptoId: notaActualizada.conceptoId,
              monto: notaActualizada.total,
            },
          ],
          monto,
          -1,
          { tipoDocumento: 'ND', documentoId: notaActualizada._id },
        );
        acumular(null, monto);

        const [creada] = await aplicaciones.create(
          [
            {
              coPropertyId,
              sourceType,
              sourceId,
              documentType: 'ND',
              documentId: candidato.doc._id,
              amountApplied: monto,
              discountApplied: 0,
              detalleConceptos: [
                {
                  conceptoId: notaActualizada.conceptoId,
                  conceptName: notaActualizada.description ?? 'Nota Débito',
                  monto,
                },
              ],
              status: 'activa',
              appliedAt: new Date(),
              appliedBy: accountId,
            },
          ],
          { session },
        );

        aplicadas.push(creada);
        resumen.push({
          tipo: 'ND',
          numero: notaActualizada.number,
          completa: notaActualizada.outstandingBalance === 0,
        });
        restante -= cashUsado;
        totalAplicado += cashUsado;
        continue;
      }

      const facturaActualizada = await decrementarSaldoFactura(
        facturas,
        saldoTotalDocumento,
        session,
        coPropertyId,
        candidato.doc._id,
        monto,
      );
      const partes = await ajustarSaldosCartera(
        saldos,
        carteraPorDocumento,
        session,
        coPropertyId,
        facturaActualizada,
        monto,
        -1,
      );
      const detalleConceptos = partes.map((parte) => {
        const linea = facturaActualizada.lines.find((l) =>
          l.conceptoId.equals(parte.conceptoId),
        );
        return {
          conceptoId: parte.conceptoId,
          conceptName: linea?.conceptName ?? 'Concepto',
          monto: parte.parte,
        };
      });
      for (const parte of partes) {
        const linea = facturaActualizada.lines.find((l) =>
          l.conceptoId.equals(parte.conceptoId),
        );
        acumular(linea?.accountingReceivableAccount ?? null, parte.parte);
        if (linea?.conceptKind === 'intereses') {
          montoAplicadoMora += parte.parte;
        }
      }

      const [creada] = await aplicaciones.create(
        [
          {
            coPropertyId,
            sourceType,
            sourceId,
            documentType: 'FV',
            documentId: candidato.doc._id,
            amountApplied: monto,
            discountApplied: montoDescuento,
            detalleConceptos,
            status: 'activa',
            appliedAt: new Date(),
            appliedBy: accountId,
          },
        ],
        { session },
      );

      aplicadas.push(creada);
      resumen.push({
        tipo: 'FV',
        numero: facturaActualizada.number,
        completa: facturaActualizada.outstandingBalance === 0,
      });
      montoDescuentoTotal += montoDescuento;
      restante -= cashUsado;
      totalAplicado += cashUsado;
    } catch (err) {
      if (!(err instanceof AplicacionInvalidaError)) {
        throw err;
      }
      errores.push({
        documentoId: candidato.doc._id.toString(),
        mensaje: err.message,
      });
    }
  }

  if (totalAplicado > 0) {
    await recibos
      .findOneAndUpdate(
        { _id: recibo._id, coPropertyId },
        {
          $inc: {
            appliedAmount: totalAplicado,
            unappliedAmount: -totalAplicado,
          },
        },
        { session },
      )
      .exec();
  }

  return {
    aplicadas,
    errores,
    montoSinAplicar: restante,
    creditosPorCuenta,
    montoAplicadoMora,
    resumen,
    montoDescuentoTotal,
  };
}
