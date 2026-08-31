import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { Tercero } from '../terceros/tercero.schema';
import { Factura } from '../facturacion/factura.schema';
import { Account } from '../cuentas/account.schema';

export type NotaCreditoDocument = HydratedDocument<NotaCredito>;

export const MOTIVOS_NOTA_CREDITO = [
  'error_facturacion',
  'descuento_comercial',
  'anulacion_documento',
  'otro',
] as const;
export type MotivoNotaCredito = (typeof MOTIVOS_NOTA_CREDITO)[number];

export const VOID_REASONS_NOTA_CREDITO = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;
export type VoidReasonNotaCredito = (typeof VOID_REASONS_NOTA_CREDITO)[number];

/** One line of `distribution` — how much of `totalAmount` corrects a given
 *  concepto on the anchor invoice (design §3.2/§6). */
@Schema({ _id: false })
export class DistribucionLinea {
  @Prop({ type: Types.ObjectId, required: true })
  conceptoId: Types.ObjectId;

  @Prop({ required: true })
  amount: number;
}

export const DistribucionLineaSchema =
  SchemaFactory.createForClass(DistribucionLinea);

/**
 * A credit note ("NC") — always issued against exactly one anchor invoice,
 * unlike `Recibo` (design §3.2: "the anchor invoice — required, unlike
 * Recibo"). `appliedAmount`/`unappliedAmount` are the mutable fields, same
 * pattern as `Recibo`/`Factura.outstandingBalance`.
 *
 * `terceroId` is nullable — see this task's own note: it is copied from
 * `factura.terceroId` at creation, which is itself nullable.
 */
@Schema({ timestamps: true, collection: 'notas_credito' })
export class NotaCredito {
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
    ref: Factura.name,
    required: true,
    index: true,
  })
  facturaId: Types.ObjectId;

  @Prop({ type: String, trim: true, default: '' })
  prefix: string;

  @Prop({ type: Number, default: 0 })
  number: number;

  @Prop({ required: true, trim: true })
  fullNumber: string;

  @Prop({ type: String, required: true, enum: MOTIVOS_NOTA_CREDITO })
  reason: MotivoNotaCredito;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ type: [DistribucionLineaSchema], required: true })
  distribution: DistribucionLinea[];

  /** Mutable cache: sum of active AplicacionCartera.amountApplied where
   *  sourceType: 'NC', sourceId: this._id. */
  @Prop({ required: true, default: 0 })
  appliedAmount: number;

  /** Mutable cache: totalAmount - appliedAmount. */
  @Prop({ required: true })
  unappliedAmount: number;

  @Prop({ type: String, default: null, trim: true })
  notes: string | null;

  @Prop({ required: true, enum: ['activo', 'anulado'], default: 'activo' })
  status: 'activo' | 'anulado';

  @Prop({ type: String, enum: VOID_REASONS_NOTA_CREDITO, default: null })
  voidedReason: VoidReasonNotaCredito | null;

  @Prop({ type: String, default: null, trim: true })
  voidedDetail: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: Account.name, default: null })
  voidedBy: Types.ObjectId | null;
}

export const NotaCreditoSchema = SchemaFactory.createForClass(NotaCredito);

// A resolution's numbers are unique within a coproperty by construction
// (NumeracionService's atomic reservation), same reasoning as Recibo/Factura.
NotaCreditoSchema.index({ coPropertyId: 1, fullNumber: 1 }, { unique: true });

// GET /notas-credito?inmuebleId=...&conAnticipoDisponible=true-shaped query,
// same reasoning as Recibo's own index.
NotaCreditoSchema.index({ coPropertyId: 1, inmuebleId: 1, unappliedAmount: 1 });
