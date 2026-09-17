import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Account } from '../cuentas/account.schema';

export type LoteSaldoInicialDocument = HydratedDocument<LoteSaldoInicial>;

/**
 * One import run of Saldos Iniciales — a traceability header, never a
 * numbered document: `SaldoInicial.numeroOriginal` is informational text the
 * client brings from their previous system, so this batch needs no
 * consecutivo of its own (unlike `LoteFacturacion`/`LoteContabilidad`).
 */
@Schema({ timestamps: true, collection: 'lotes_saldo_inicial' })
export class LoteSaldoInicial {
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

export const LoteSaldoInicialSchema =
  SchemaFactory.createForClass(LoteSaldoInicial);
