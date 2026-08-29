import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ConsecutivoLoteDocument = HydratedDocument<ConsecutivoLote>;

/**
 * The running batch number for one coproperty's billing cycles.
 *
 * Separate from ConsecutivoDocumento on purpose: a Lote is an internal batch
 * marker, never a DIAN document type, so it does not belong in
 * TIPOS_DOCUMENTO. The real legacy export names this `numlotefv` — a plain
 * per-coproperty integer, confirming it is exactly this and nothing fancier
 * (not a year-month label).
 */
@Schema({ timestamps: true, collection: 'consecutivos_lote' })
export class ConsecutivoLote {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    unique: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  /** The next number to hand out. Moves forward only. */
  @Prop({ required: true, default: 1 })
  nextNumber: number;
}

export const ConsecutivoLoteSchema =
  SchemaFactory.createForClass(ConsecutivoLote);
