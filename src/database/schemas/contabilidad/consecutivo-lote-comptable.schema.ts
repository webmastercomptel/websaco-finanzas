import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ConsecutivoLoteComptableDocument =
  HydratedDocument<ConsecutivoLoteComptable>;

/**
 * Running number of one coproperty's "Interfaz a Comptable" lotes. Separate
 * from `ConsecutivoLoteContabilidad` (the CSV export) on purpose: the two
 * channels are independent, and sharing a sequence would make "lote 4"
 * ambiguous about which channel it belongs to.
 */
@Schema({ timestamps: true, collection: 'consecutivos_lote_comptable' })
export class ConsecutivoLoteComptable {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    unique: true,
  })
  copropiedadId: Types.ObjectId;

  /** The LAST number issued; 0 means none yet. */
  @Prop({ required: true, default: 0 })
  siguienteNumero: number;
}

export const ConsecutivoLoteComptableSchema = SchemaFactory.createForClass(
  ConsecutivoLoteComptable,
);
