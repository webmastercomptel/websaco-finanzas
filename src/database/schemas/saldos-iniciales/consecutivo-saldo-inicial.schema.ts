import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ConsecutivoSaldoInicialDocument =
  HydratedDocument<ConsecutivoSaldoInicial>;

/**
 * The running INTERNAL ordinal for one coproperty's Saldos Iniciales — never
 * a real DIAN/fiscal consecutivo (unlike `ConsecutivoDocumento`): a Saldo
 * Inicial is numbered here purely so it has a bare `number` to show in the
 * same places a Factura/Nota Débito's own `number` shows (a Recibo's
 * redacted Observaciones, an accounting line's "documento cruce") — its real
 * identity, as far as the client's previous system is concerned, is
 * `tipoDocumentoOriginal`/`numeroOriginal` (free text, see `SaldoInicial`'s
 * own schema docblock). Same "counter row, not COUNT()" reasoning as every
 * other consecutivo in this codebase, so two rows imported concurrently
 * never collide on the same ordinal.
 */
@Schema({ timestamps: true, collection: 'consecutivos_saldo_inicial' })
export class ConsecutivoSaldoInicial {
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

export const ConsecutivoSaldoInicialSchema = SchemaFactory.createForClass(
  ConsecutivoSaldoInicial,
);
