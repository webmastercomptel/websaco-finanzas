import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { Tercero } from '../terceros/tercero.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';
import { Account } from '../cuentas/account.schema';

export type NotaDebitoDocument = HydratedDocument<NotaDebito>;

export const VOID_REASONS_NOTA_DEBITO = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;
export type VoidReasonNotaDebito = (typeof VOID_REASONS_NOTA_DEBITO)[number];

/**
 * A debit note ("ND") — a payable document issued against a unit, similar
 * in lifecycle to a Factura. Unlike NotaCredito it does not anchor to an
 * invoice; it carries its own concepto and outstanding balance that a
 * future Recibo will reduce.
 *
 * `terceroId` is nullable — the third party is copied from the unit's
 * current titular at creation time.
 */
@Schema({ timestamps: true, collection: 'notas_debito' })
export class NotaDebito {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: Inmueble.name,
    required: true,
    index: true,
  })
  inmuebleId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: Tercero.name, default: null })
  terceroId: Types.ObjectId | null;

  @Prop({
    type: Types.ObjectId,
    ref: ConceptoCobro.name,
    required: true,
  })
  conceptoId: Types.ObjectId;

  @Prop({ type: String, default: null, trim: true })
  description: string | null;

  @Prop({ type: String, trim: true, default: '' })
  prefix: string;

  @Prop({ type: Number, default: 0 })
  number: number;

  @Prop({ required: true, trim: true })
  fullNumber: string;

  @Prop({ required: true })
  issueDate: Date;

  @Prop({ required: true })
  total: number;

  /** Mutable cache: starts equal to `total`; a future Recibo decreases it. */
  @Prop({ required: true })
  outstandingBalance: number;

  @Prop({ required: true, enum: ['emitida', 'anulada'], default: 'emitida' })
  status: 'emitida' | 'anulada';

  @Prop({ type: String, enum: VOID_REASONS_NOTA_DEBITO, default: null })
  voidedReason: VoidReasonNotaDebito | null;

  @Prop({ type: String, default: null, trim: true })
  voidedDetail: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: Account.name, default: null })
  voidedBy: Types.ObjectId | null;
}

export const NotaDebitoSchema = SchemaFactory.createForClass(NotaDebito);

// A resolution's numbers are unique within a coproperty by construction
// (NumeracionService's atomic reservation), same reasoning as Recibo/Factura.
NotaDebitoSchema.index({ coPropertyId: 1, fullNumber: 1 }, { unique: true });

// GET /notas-debito?inmuebleId=...-shaped query — outstanding balance per unit.
NotaDebitoSchema.index({
  coPropertyId: 1,
  inmuebleId: 1,
  outstandingBalance: 1,
});
