import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { Tercero } from '../terceros/tercero.schema';
import { Account } from '../cuentas/account.schema';

export type ReciboDocument = HydratedDocument<Recibo>;

export const PAYMENT_METHODS = [
  'transferencia',
  'cheque',
  'pse',
  'efectivo',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const VOID_REASONS = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

/**
 * A cash receipt ("RC") — the payment header. `appliedAmount` and
 * `unappliedAmount` are the mutable fields, same pattern as
 * `Factura.outstandingBalance`: everything else on a Recibo is immutable
 * once created, and these two caches move only inside the transactions in
 * `recibos.service.ts` (see design §3 and §6).
 */
@Schema({ timestamps: true, collection: 'recibos' })
export class Recibo {
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

  @Prop({ type: Types.ObjectId, ref: Tercero.name, required: true })
  terceroId: Types.ObjectId;

  @Prop({ type: String, trim: true, default: '' })
  prefix: string;

  @Prop({ type: Number, default: 0 })
  number: number;

  @Prop({ required: true, trim: true })
  fullNumber: string;

  @Prop({ required: true })
  receivedAmount: number;

  @Prop({ required: true })
  receivedDate: Date;

  @Prop({ type: String, required: true, enum: PAYMENT_METHODS })
  paymentMethod: PaymentMethod;

  @Prop({ required: true, trim: true })
  destinationAccount: string;

  @Prop({ type: String, default: null, trim: true })
  reference: string | null;

  @Prop({ type: String, default: null, trim: true })
  notes: string | null;

  /** Mutable cache: sum of active AplicacionRecibo.amountApplied. */
  @Prop({ required: true, default: 0 })
  appliedAmount: number;

  /** Mutable cache: receivedAmount - appliedAmount. "Available anticipo" is
   *  simply this being > 0 on an activo Recibo — see design §3. */
  @Prop({ required: true })
  unappliedAmount: number;

  @Prop({ required: true, enum: ['activo', 'anulado'], default: 'activo' })
  status: 'activo' | 'anulado';

  @Prop({ type: String, enum: VOID_REASONS, default: null })
  voidedReason: VoidReason | null;

  @Prop({ type: String, default: null, trim: true })
  voidedDetail: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;
}

export const ReciboSchema = SchemaFactory.createForClass(Recibo);

// A resolution's numbers are unique within a coproperty by construction
// (NumeracionService's atomic reservation), but a compound index here makes
// that guarantee visible to the database too — same reasoning as
// FacturaSchema's own {coPropertyId, fullNumber} index.
ReciboSchema.index({ coPropertyId: 1, fullNumber: 1 }, { unique: true });

// GET /recibos?conAnticipoDisponible=true, usually combined with inmuebleId
// (design §5) — this is the exact shape of that query.
ReciboSchema.index({ coPropertyId: 1, inmuebleId: 1, unappliedAmount: 1 });
