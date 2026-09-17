import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ConsecutivoSaldoInicialAnticipoDocument =
  HydratedDocument<ConsecutivoSaldoInicialAnticipo>;

/**
 * The running INTERNAL ordinal for one coproperty's Saldos Iniciales de
 * Anticipo — same "counter row, not COUNT()" reasoning as
 * `ConsecutivoSaldoInicial`, kept as its own independent sequence rather than
 * sharing that one: cargos and anticipos are two different document
 * collections (`SaldoInicial` vs `SaldoInicialAnticipo`), so numbering them
 * off the same counter would produce gaps in each one's own sequence with no
 * reader that benefits from it.
 */
@Schema({ timestamps: true, collection: 'consecutivos_saldo_inicial_anticipo' })
export class ConsecutivoSaldoInicialAnticipo {
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

export const ConsecutivoSaldoInicialAnticipoSchema =
  SchemaFactory.createForClass(ConsecutivoSaldoInicialAnticipo);
