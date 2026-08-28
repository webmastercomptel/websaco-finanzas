// src/database/schemas/conceptos/valor-recurrente.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { ConceptoCobro } from './concepto-cobro.schema';

export type ValorRecurrenteDocument = HydratedDocument<ValorRecurrente>;

/**
 * What a unit is charged for a given concept, month after month.
 *
 * This is the template the monthly cycle reads to build each invoice — the
 * "Datos Financieros" tab of the system this replaces, where the twelve concept
 * columns sat on the unit record itself. As rows instead, a building can carry
 * as many concepts as it needs and a unit simply has no row for the ones that
 * do not apply to it.
 *
 * A template, not a ledger entry: changing an amount here affects invoices
 * generated from now on and never touches one already issued.
 */
@Schema({ timestamps: true, collection: 'valores_recurrentes' })
export class ValorRecurrente {
  /** Denormalised from the unit so tenant filtering never needs a join. */
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

  /**
   * Amount charged each cycle.
   *
   * Representation — plain number of currency units versus integer cents — is
   * settled once, for the whole ledger, when the financial documents are
   * designed. Whatever is decided there applies here unchanged: a template and
   * the invoice built from it disagreeing about units would be a rounding bug
   * nobody could see.
   */
  @Prop({ required: true, default: 0 })
  amount: number;
}

export const ValorRecurrenteSchema =
  SchemaFactory.createForClass(ValorRecurrente);

// One amount per unit per concept. Two rows for the same pair would make the
// monthly charge depend on which one the query happened to read first.
ValorRecurrenteSchema.index({ inmuebleId: 1, conceptoId: 1 }, { unique: true });
