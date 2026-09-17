import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { Tercero } from '../terceros/tercero.schema';
import { ResolucionFacturacion } from '../numeracion/resolucion-facturacion.schema';
import {
  FacturaLinea,
  FacturaLineaSchema,
  TitularCongelado,
  TitularCongeladoSchema,
} from './factura-linea.schema';

export type FacturaDocument = HydratedDocument<Factura>;

export const VOID_REASONS_FACTURA = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;
export type VoidReasonFactura = (typeof VOID_REASONS_FACTURA)[number];

/**
 * A sales invoice ("FV"). Only ever created already-numbered, at the moment
 * a LoteFacturacion is consolidated — there is no draft Factura. While a
 * unit's invoice is being prepared it lives as a FacturaPreliminar embedded
 * in its Lote (see lote-facturacion.schema.ts); a Factura row appearing at
 * all means NumeracionService already reserved its number.
 */
@Schema({ timestamps: true, collection: 'facturas' })
export class Factura {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'LoteFacturacion',
    required: true,
    index: true,
  })
  loteId: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Inmueble.name,
    required: true,
    index: true,
  })
  inmuebleId: Types.ObjectId;

  /** Frozen — see the note on Tercero's schema for why a unit's code
   *  changing later must not alter an already-issued document. */
  @Prop({ required: true, trim: true })
  unitCode: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: Tercero.name, default: null })
  terceroId: Types.ObjectId | null;

  @Prop({ type: TitularCongeladoSchema, default: null })
  holder: TitularCongelado | null;

  /**
   * Null when this invoice was numbered through the simple FV consecutivo
   * instead of a DIAN resolution — the DIAN electronic-invoicing filing is
   * not mandatory for every client, so a coproperty without one still needs
   * a way to issue invoices. See NumeracionService.siguienteFactura.
   */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: ResolucionFacturacion.name,
    default: null,
  })
  resolucionId: Types.ObjectId | null;

  @Prop({ required: true, trim: true, default: '' })
  prefix: string;

  @Prop({ required: true })
  number: number;

  @Prop({ required: true, trim: true })
  fullNumber: string;

  @Prop({ required: true })
  issueDate: Date;

  @Prop({ required: true })
  dueDate: Date;

  @Prop({ required: true })
  periodStart: Date;

  @Prop({ required: true })
  periodEnd: Date;

  @Prop({ type: [FacturaLineaSchema], required: true, default: [] })
  lines: FacturaLinea[];

  @Prop({ required: true })
  subtotal: number;

  @Prop({ required: true, default: 0 })
  totalTax: number;

  @Prop({ required: true })
  total: number;

  /** The one mutable field on an otherwise immutable document. Starts equal
   *  to `total`; a future Recibo decreases it. */
  @Prop({ required: true })
  outstandingBalance: number;

  /**
   * Early-payment discount this invoice offers — computed ONCE at
   * `consolidar()` time from the lote's own `earlyPaymentDiscount`/
   * `earlyPaymentDiscountFixedValue` against this invoice's own
   * Administración cargo, and frozen here forever after, same immutability
   * as every other field above (`total`, `lines`, …) — an invoice's terms
   * never change after it is issued. 0 when the invoice carries any mora
   * line and `Copropiedad.discountAppliesWithLateFee` is false (the
   * default), or when the lote had no discount configured at all. See
   * `calcularDescuentoProntoPago` (`common/facturacion/descuento-pronto-
   * pago.util.ts`) for the exact rule.
   */
  @Prop({ required: true, default: 0 })
  discountAmount: number;

  /** Last date a Recibo still earns `discountAmount` — copied verbatim from
   *  `LoteFacturacion.discountDeadline` at `consolidar()` time. Always null
   *  exactly when `discountAmount` is 0 — never read on its own. */
  @Prop({ type: Date, default: null })
  discountDeadline: Date | null;

  @Prop({ required: true, enum: ['emitida', 'anulada'], default: 'emitida' })
  status: 'emitida' | 'anulada';

  /** Set together with the four fields below it, at the same anulación —
   *  the Nota Crédito that reversed this invoice's cartera and accounting
   *  entries (see `AnularFacturaService`). Never set on its own. */
  @Prop({ type: SchemaTypes.ObjectId, default: null })
  voidedByCreditNoteId: Types.ObjectId | null;

  @Prop({ type: String, enum: VOID_REASONS_FACTURA, default: null })
  voidedReason: VoidReasonFactura | null;

  @Prop({ type: String, default: null, trim: true })
  voidedDetail: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Account', default: null })
  voidedBy: Types.ObjectId | null;
}

export const FacturaSchema = SchemaFactory.createForClass(Factura);

// A resolution's numbers are unique within a coproperty by construction
// (NumeracionService's atomic reservation), but a compound index here makes
// that guarantee visible to the database too, not just to the code path
// that happens to be the only writer today.
FacturaSchema.index({ coPropertyId: 1, fullNumber: 1 }, { unique: true });
