import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Account } from '../cuentas/account.schema';

export type LoteSaldoInicialAnticipoDocument =
  HydratedDocument<LoteSaldoInicialAnticipo>;

/**
 * One import run of Saldos Iniciales de Anticipo — a traceability header,
 * same role as `LoteSaldoInicial` for the cargo side, kept as its own
 * collection rather than shared with it since the two imports are
 * independent files with independent tallies.
 */
@Schema({ timestamps: true, collection: 'lotes_saldo_inicial_anticipo' })
export class LoteSaldoInicialAnticipo {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ required: true })
  totalFilas: number;

  @Prop({ required: true })
  totalMonto: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  importedBy: Types.ObjectId;
}

export const LoteSaldoInicialAnticipoSchema = SchemaFactory.createForClass(
  LoteSaldoInicialAnticipo,
);
