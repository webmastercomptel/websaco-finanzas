import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';

/**
 * A party's identity as it must print on an issued document, frozen at
 * emission time. Never re-read from Tercero afterward — the same reasoning
 * already written into the Tercero schema: correcting a typo today must
 * never change what a document already issued says.
 */
@Schema({ _id: false })
export class TitularCongelado {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, default: null, trim: true })
  identificationType: string | null;

  @Prop({ type: String, default: null, trim: true })
  identificationNumber: string | null;

  @Prop({ type: String, default: null, trim: true })
  identificationVerificationDigit: string | null;

  @Prop({ type: String, default: null, trim: true })
  address: string | null;

  @Prop({ type: String, default: null, trim: true })
  city: string | null;

  @Prop({ type: String, default: null, trim: true })
  email: string | null;
}

export const TitularCongeladoSchema =
  SchemaFactory.createForClass(TitularCongelado);

/**
 * One invoice line. Everything about the concept it charges is frozen at the
 * moment the line is built — see ConceptoCobro's own schema comment for why:
 * "changing it here must never alter what an issued invoice says."
 */
@Schema({ _id: false })
export class FacturaLinea {
  @Prop({
    type: Types.ObjectId,
    ref: ConceptoCobro.name,
    required: true,
  })
  conceptoId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  nombreConcepto: string;

  @Prop({
    required: true,
    enum: ['administracion', 'intereses', 'otro'],
  })
  tipoConcepto: 'administracion' | 'intereses' | 'otro';

  @Prop({ type: String, default: null, trim: true })
  cuentaContableIngreso: string | null;

  /** Whether this line came from the unit's standing monthly template, a
   *  one-off novedad for this run, or the computed mora interest line. */
  @Prop({
    required: true,
    enum: ['recurrente', 'novedad', 'interes'],
  })
  origen: 'recurrente' | 'novedad' | 'interes';

  @Prop({ required: true })
  valorBase: number;

  @Prop({ required: true, default: 0 })
  tasaImpuesto: number;

  @Prop({ required: true, default: 0 })
  valorImpuesto: number;

  @Prop({ required: true })
  valorTotal: number;
}

export const FacturaLineaSchema = SchemaFactory.createForClass(FacturaLinea);
