import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { LoteFacturacion } from './lote-facturacion.schema';
import { Factura } from './factura.schema';

export type AsientoContableDocument = HydratedDocument<AsientoContable>;

/** One debit or credit line of a journal entry. */
@Schema({ _id: false })
export class Movimiento {
  @Prop({ required: true, trim: true })
  account: string;

  @Prop({ required: true, enum: ['debito', 'credito'] })
  type: 'debito' | 'credito';

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true, trim: true })
  description: string;
}

export const MovimientoSchema = SchemaFactory.createForClass(Movimiento);

/**
 * The double-entry journal entry a consolidated Factura produces. Generated
 * at the same moment the invoice is created — never before (nothing is
 * posted for a preview that might be discarded) and never separately.
 *
 * Invariant this schema does not itself enforce (LotesFacturacionService
 * does, before ever calling `.create()`): sum(debito) === sum(credito).
 */
@Schema({ timestamps: true, collection: 'asientos_contables' })
export class AsientoContable {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: LoteFacturacion.name, required: true })
  loteId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: Factura.name, required: true })
  facturaId: Types.ObjectId;

  @Prop({ required: true })
  date: Date;

  @Prop({ type: [MovimientoSchema], required: true })
  entries: Movimiento[];
}

export const AsientoContableSchema =
  SchemaFactory.createForClass(AsientoContable);

// One AsientoContable per Factura — cheap structural insurance against a
// double-post, given this method runs without a database transaction.
AsientoContableSchema.index({ facturaId: 1 }, { unique: true });
