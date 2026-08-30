import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';

export type SaldoCarteraDocument = HydratedDocument<SaldoCartera>;

/**
 * What one unit currently owes for one concept, across every unpaid
 * invoice. A RECONCILABLE CACHE, never a second source of truth.
 *
 * TWO sources move this number, and a rebuild that forgets either one is
 * destructive:
 *  1. `LotesFacturacionService.consolidar()` INCREMENTS it by each new
 *     Factura line's `totalAmount`.
 *  2. `cruce.util.ts`'s `ajustarSaldosCartera` DECREMENTS it by each payment
 *     applied through a Recibo de Caja (`AplicacionRecibo`), split across the
 *     Factura's lines proportionally to their `totalAmount` — and increments
 *     it back when such an application is reversed by `anular`.
 *
 * So this is NOT `sum(totalAmount)` over the unit's unpaid Factura lines, and
 * it CANNOT be rebuilt from Factura line amounts alone: doing that would
 * silently erase every payment ever recorded against this cache and restore
 * each balance to its pre-payment value. Payments live in `AplicacionRecibo`
 * (and, aggregated per invoice, in `Factura.outstandingBalance`), not in
 * `lines[].totalAmount`, which a payment never touches.
 *
 * A CORRECT rebuild for one (inmueble, concepto) must therefore start from
 * the line amounts and then subtract the proportional share of every `activa`
 * `AplicacionRecibo` against those same Facturas — the same split
 * `ajustarSaldosCartera` applies — so the per-concept parts still add up to
 * each Factura's `outstandingBalance`. No such rebuild function exists today;
 * whoever writes one must account for applications, or it corrupts rather
 * than repairs.
 *
 * Maintained rather than queried live because, unlike a formatting choice,
 * summing years of invoice history on every monthly consolidación degrades
 * exactly the process that has to run reliably every month at scale.
 */
@Schema({ timestamps: true, collection: 'saldos_cartera' })
export class SaldoCartera {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: Inmueble.name,
    required: true,
    index: true,
  })
  inmuebleId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: ConceptoCobro.name,
    required: true,
    index: true,
  })
  conceptoId: Types.ObjectId;

  @Prop({ required: true, default: 0 })
  balance: number;
}

export const SaldoCarteraSchema = SchemaFactory.createForClass(SaldoCartera);

// One running balance per unit per concept — the same reasoning as
// ValorRecurrente's own index.
SaldoCarteraSchema.index({ inmuebleId: 1, conceptoId: 1 }, { unique: true });
