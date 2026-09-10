import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ConsecutivoLoteRecibosDocument =
  HydratedDocument<ConsecutivoLoteRecibos>;

/**
 * The running batch number for one coproperty's Recibos-por-lote uploads.
 * A separate counter from `ConsecutivoLote` (Facturación's own lote
 * numbering) on purpose — the two are unrelated batch concepts, and sharing
 * a sequence would only make "lote #4" ambiguous about which kind it is.
 * Same "counter row, not COUNT()" reasoning as every other consecutivo in
 * this codebase: two uploads saved at once must never collide on the same
 * number.
 */
@Schema({ timestamps: true, collection: 'consecutivos_lote_recibos' })
export class ConsecutivoLoteRecibos {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    unique: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ required: true, default: 0 })
  nextNumber: number;
}

export const ConsecutivoLoteRecibosSchema = SchemaFactory.createForClass(
  ConsecutivoLoteRecibos,
);
