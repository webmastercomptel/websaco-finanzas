import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';

export type SaldoCarteraDocument = HydratedDocument<SaldoCartera>;

/**
 * What one unit currently owes for one concept, across every unpaid
 * invoice. A RECONCILABLE CACHE, never a second source of truth: this
 * number must always equal the sum of `totalAmount` across that unit's
 * unpaid Factura lines for this concept. If it is ever suspected to have
 * drifted, it can be rebuilt from Factura documents alone — nothing is
 * lost by deleting and recomputing it.
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
