import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';
import { Account } from '../cuentas/account.schema';

export type NotaContableDocument = HydratedDocument<NotaContable>;

export const VOID_REASONS_NOTA_CONTABLE = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;
export type VoidReasonNotaContable =
  (typeof VOID_REASONS_NOTA_CONTABLE)[number];

/**
 * An accounting reclassification note ("NT") — moves an amount between two
 * ConceptoCobro balances within one inmueble's cartera.
 *
 * Unlike Factura/NotaDebito (payable documents with outstandingBalance) or
 * Recibo/NotaCredito (application sources with unappliedAmount), a
 * NotaContable is a one-shot event: the full `monto` moves atomically at
 * creation time. No outstanding balance, no application lifecycle.
 */
@Schema({ timestamps: true, collection: 'notas_contables' })
export class NotaContable {
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

  @Prop({
    type: Types.ObjectId,
    ref: ConceptoCobro.name,
    required: true,
  })
  conceptoOrigenId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: ConceptoCobro.name,
    required: true,
  })
  conceptoDestinoId: Types.ObjectId;

  @Prop({ required: true })
  monto: number;

  @Prop({ required: true, trim: true })
  description: string;

  @Prop({ type: String, trim: true, default: '' })
  prefix: string;

  @Prop({ type: Number, default: 0 })
  number: number;

  @Prop({ required: true, trim: true })
  fullNumber: string;

  @Prop({ required: true, enum: ['activo', 'anulado'], default: 'activo' })
  status: 'activo' | 'anulado';

  @Prop({ type: String, enum: VOID_REASONS_NOTA_CONTABLE, default: null })
  voidedReason: VoidReasonNotaContable | null;

  @Prop({ type: String, default: null, trim: true })
  voidedDetail: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: Account.name, default: null })
  voidedBy: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;
}

export const NotaContableSchema = SchemaFactory.createForClass(NotaContable);

// Unique numbering per coproperty — same reasoning as Recibo/Factura.
NotaContableSchema.index({ coPropertyId: 1, fullNumber: 1 }, { unique: true });

// GET /notas-contables?inmuebleId=...-shaped query.
NotaContableSchema.index({ coPropertyId: 1, inmuebleId: 1 });
