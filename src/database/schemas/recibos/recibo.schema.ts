import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
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
 * A cash receipt ("RC") — the payment header. `montoAplicado` and
 * `montoSinAplicar` are the mutable fields, same pattern as
 * `Factura.saldoPendiente`: everything else on a Recibo is immutable
 * once created, and these two caches move only inside the transactions in
 * `recibos.service.ts` (see design §3 and §6).
 */
@Schema({ timestamps: true, collection: 'recibos' })
export class Recibo {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  copropiedadId: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Inmueble.name,
    required: true,
    index: true,
  })
  inmuebleId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: Tercero.name, required: true })
  terceroId: Types.ObjectId;

  @Prop({ type: String, trim: true, default: '' })
  prefijo: string;

  @Prop({ type: Number, default: 0 })
  numero: number;

  @Prop({ required: true, trim: true })
  numeroCompleto: string;

  @Prop({ required: true })
  montoRecibido: number;

  @Prop({ required: true })
  fechaRecibo: Date;

  @Prop({ type: String, required: true, enum: PAYMENT_METHODS })
  medioPago: PaymentMethod;

  @Prop({ required: true, trim: true })
  cuentaDestino: string;

  @Prop({ type: String, default: null, trim: true })
  referencia: string | null;

  @Prop({ type: String, default: null, trim: true })
  observaciones: string | null;

  /** Mutable cache: sum of active AplicacionCartera.montoAplicado. */
  @Prop({ required: true, default: 0 })
  montoAplicado: number;

  /** Mutable cache: montoRecibido - montoAplicado. "Available anticipo" is
   *  simply this being > 0 on an activo Recibo — see design §3. */
  @Prop({ required: true })
  montoSinAplicar: number;

  @Prop({ required: true, enum: ['activo', 'anulado'], default: 'activo' })
  estado: 'activo' | 'anulado';

  @Prop({ type: String, enum: VOID_REASONS, default: null })
  motivoAnulacion: VoidReason | null;

  @Prop({ type: String, default: null, trim: true })
  detalleAnulacion: string | null;

  @Prop({ type: Date, default: null })
  fechaAnulacion: Date | null;

  /**
   * Frozen at creation — the portion of a payment SURPLUS the user sent to
   * Otros Ingresos instead of Anticipos (`CrearReciboDto.destinoSobrante`,
   * manual mode only). Unlike a discount, which always attaches to a
   * specific factura/ND line and so can be summed back from
   * `AplicacionCartera.montoDescuento`, this money never touched any
   * document — there's nothing to derive it from, so it has to live here.
   * Immutable after creation, same as the rest of a Recibo bar `estado`,
   * `motivoAnulacion`/`detalleAnulacion`/`fechaAnulacion`/`anuladoPor`, and
   * the two `SaldoDocumentoOrigen`-derived caches.
   */
  @Prop({ required: true, default: 0 })
  montoOtrosIngresos: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generadoPor: Types.ObjectId;

  /**
   * Who voided it — the counterpart of `generadoPor` (and of
   * `AplicacionCartera.appliedBy`) for the one operation that had no actor
   * recorded at all. Voiding is this module's most audit-sensitive action:
   * it is gated behind a mandatory reason plus a 20-character justification,
   * and it cascades through every application the receipt made. `null` until
   * then, and on every receipt that was never voided.
   *
   * Persisted only, never mapped into the API contract, same as
   * `generadoPor` and `appliedBy`, which no `Recibo`/`AplicacionCartera`
   * response exposes either.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, default: null })
  anuladoPor: Types.ObjectId | null;
}

export const ReciboSchema = SchemaFactory.createForClass(Recibo);

// A resolution's numbers are unique within a coproperty by construction
// (NumeracionService's atomic reservation), but a compound index here makes
// that guarantee visible to the database too — same reasoning as
// FacturaSchema's own {copropiedadId, numeroCompleto} index.
ReciboSchema.index({ copropiedadId: 1, numeroCompleto: 1 }, { unique: true });

// GET /recibos?conAnticipoDisponible=true, usually combined with inmuebleId
// (design §5) — this is the exact shape of that query.
ReciboSchema.index({ copropiedadId: 1, inmuebleId: 1, montoSinAplicar: 1 });
