import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';
import { Account } from '../cuentas/account.schema';
import { Tercero } from '../terceros/tercero.schema';
import {
  FacturaLinea,
  FacturaLineaSchema,
  TitularCongelado,
  TitularCongeladoSchema,
} from './factura-linea.schema';

export type LoteFacturacionDocument = HydratedDocument<LoteFacturacion>;

/**
 * A one-off charge for this run only — never written back into
 * ValorRecurrente, the standing monthly template. Has its own `_id` (schema
 * default, not disabled here) so a single row can be targeted individually by
 * `PATCH /lotes/:id/novedades/:novedadId` — needed once editing became
 * per-line instead of "replace the whole file".
 *
 * `overrides` is null for an ordinary additive charge (the Excel/manual case
 * that always existed): it becomes its own FacturaLinea, alongside whatever
 * else the unit is charged. Set to `'recurrente'` or `'interes'`, it instead
 * REPLACES what construirPreview() would have computed from ValorRecurrente
 * or from the mora calculation for that same (inmuebleId, conceptoId) — the
 * mechanism behind "edit any line of the table, including a recurring quota
 * or the mora charge, for this run only, without touching the permanent
 * ValorRecurrente or the general mora formula".
 */
@Schema()
export class NovedadLote {
  /** Mongoose-assigned (schema default, not `_id: false`); declared here only
   *  so TypeScript knows it exists on the plain class shape. */
  _id: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: Inmueble.name, required: true })
  inmuebleId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: ConceptoCobro.name, required: true })
  conceptoId: Types.ObjectId;

  @Prop({ required: true })
  amount: number;

  @Prop({ type: String, default: null, trim: true })
  note: string | null;

  @Prop({ type: String, enum: ['recurrente', 'interes'], default: null })
  overrides: 'recurrente' | 'interes' | null;
}

export const NovedadLoteSchema = SchemaFactory.createForClass(NovedadLote);

/**
 * One unit's computed-but-not-yet-issued invoice. Everything Factura needs
 * except what only consolidación assigns: no `number`, no `fullNumber`, no
 * `resolucionId`, no `outstandingBalance`, no `status`.
 */
@Schema({ _id: false })
export class FacturaPreliminar {
  @Prop({ type: SchemaTypes.ObjectId, ref: Inmueble.name, required: true })
  inmuebleId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  unitCode: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: Tercero.name, default: null })
  terceroId: Types.ObjectId | null;

  @Prop({ type: TitularCongeladoSchema, default: null })
  holder: TitularCongelado | null;

  @Prop({ type: [FacturaLineaSchema], required: true, default: [] })
  lines: FacturaLinea[];

  @Prop({ required: true })
  subtotal: number;

  @Prop({ required: true, default: 0 })
  totalTax: number;

  @Prop({ required: true })
  total: number;
}

export const FacturaPreliminarSchema =
  SchemaFactory.createForClass(FacturaPreliminar);

/**
 * One billing run. Persisted, not derived, so its exact parameters (the
 * discount and mora rates, the novedades that were uploaded) stay
 * inspectable long after the run is consolidado, and so a run in progress
 * survives a page refresh. See the design doc's §3.1 for the full reasoning,
 * including why `number` is its own atomic counter rather than reusing
 * ConsecutivoDocumento's TIPOS_DOCUMENTO.
 */
@Schema({ timestamps: true, collection: 'lotes_facturacion' })
export class LoteFacturacion {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ required: true })
  number: number;

  @Prop({
    required: true,
    enum: ['borrador', 'liquidado', 'consolidado'],
    default: 'borrador',
  })
  status: 'borrador' | 'liquidado' | 'consolidado';

  @Prop({ required: true })
  billingDate: Date;

  @Prop({ required: true })
  dueDate: Date;

  @Prop({ required: true })
  periodStart: Date;

  @Prop({ required: true })
  periodEnd: Date;

  // Percentage form of the discount — mutually exclusive with
  // `earlyPaymentDiscountFixedValue` below (Parámetros de Facturación §4's
  // own rule: a fixed value only applies when there is no percentage).
  // Applied per-invoice at `consolidar()` time, frozen onto each
  // `Factura.discountAmount` — see that field's own comment.
  @Prop({ required: true, default: 0 })
  earlyPaymentDiscount: number;

  // Fixed-value form of the discount, used INSTEAD of `earlyPaymentDiscount`
  // when that percentage is 0 — same exclusion rule as
  // `Copropiedad.discountFixedValue`, which this defaults from at `crear()`
  // time (same pattern as `discountGraceDays` below).
  @Prop({ required: true, default: 0 })
  earlyPaymentDiscountFixedValue: number;

  @Prop({ required: true, default: 0 })
  discountGraceDays: number;

  @Prop({ required: true, default: 0 })
  lateInterestRate: number;

  /**
   * Minimum overdue balance before mora is calculated for a unit this run —
   * not a ceiling. See the note on `Copropiedad.lateFeeValueLimit`, which
   * this defaults from at `crear()` time; a coproperty admin may override it
   * per-lote here without changing the standing parameter.
   */
  @Prop({ type: Number, default: null })
  lateInterestCap: number | null;

  /**
   * "Fecha límite para descuento" — the last date a payment still earns the
   * early-payment discount. Defaults at `crear()` time to
   * `billingDate + discountGraceDays - 1 día`, editable per-lote same as
   * every other field on this screen (design note in `crear-lote.dto.ts`).
   * Frozen onto each `Factura.discountDeadline` at `consolidar()` time — see
   * that field's own comment.
   */
  @Prop({ required: true })
  discountDeadline: Date;

  /**
   * "Fecha de suspensión del servicio" — defaults to `periodEnd` (the last
   * day of the billing month), editable per-lote. Not yet read anywhere.
   */
  @Prop({ required: true })
  serviceSuspensionDate: Date;

  @Prop({ type: [NovedadLoteSchema], required: true, default: [] })
  adjustments: NovedadLote[];

  @Prop({ type: [FacturaPreliminarSchema], required: true, default: [] })
  preview: FacturaPreliminar[];

  @Prop({
    type: [SchemaTypes.ObjectId],
    ref: 'Factura',
    required: true,
    default: [],
  })
  invoiceIds: Types.ObjectId[];

  @Prop({
    type: {
      totalAmount: { type: Number, required: true },
      totalInvoices: { type: Number, required: true },
      totalUnits: { type: Number, required: true },
    },
    default: null,
  })
  summary: {
    totalAmount: number;
    totalInvoices: number;
    totalUnits: number;
  } | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;
}

export const LoteFacturacionSchema =
  SchemaFactory.createForClass(LoteFacturacion);

// At most one run in flight per coproperty at a time — a second one would
// make "which lote am I liquidando" ambiguous. Explicit name required: the
// key pattern is identical to the general-purpose `coPropertyId` index
// implied by that field's own `index: true` (kept for unscoped lookups like
// findAll()'s `find({coPropertyId})`, which must also match consolidado
// rows this partial index deliberately excludes) — without distinct names,
// Mongoose auto-names both `coPropertyId_1` and MongoDB rejects the second
// with IndexOptionsConflict, silently leaving this uniqueness unenforced.
LoteFacturacionSchema.index(
  { coPropertyId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['borrador', 'liquidado'] } },
    name: 'unico_lote_en_curso_por_copropiedad',
  },
);
