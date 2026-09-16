import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ConsecutivoLoteContabilidadDocument =
  HydratedDocument<ConsecutivoLoteContabilidad>;

/**
 * The running batch number for one coproperty's "Adición a Contabilidad"
 * exports (MOVMES.csv/MOVMESDO.csv) — the real legacy export's own
 * `numlotefv`-style counter, applied to this export instead. A separate
 * counter from `ConsecutivoLote` (Facturación's lote) and
 * `ConsecutivoLoteRecibos` (Recibos-por-lote) on purpose, same reasoning as
 * those two: unrelated batch concepts, sharing a sequence would only make
 * "lote #4" ambiguous about which kind it is.
 */
@Schema({ timestamps: true, collection: 'consecutivos_lote_contabilidad' })
export class ConsecutivoLoteContabilidad {
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

export const ConsecutivoLoteContabilidadSchema = SchemaFactory.createForClass(
  ConsecutivoLoteContabilidad,
);
