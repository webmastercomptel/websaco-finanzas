import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
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

/** A one-off charge for this run only — never written back into
 *  ValorRecurrente, the standing monthly template. */
@Schema({ _id: false })
export class NovedadLote {
  @Prop({ type: Types.ObjectId, ref: Inmueble.name, required: true })
  inmuebleId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: ConceptoCobro.name, required: true })
  conceptoId: Types.ObjectId;

  @Prop({ required: true })
  amount: number;

  @Prop({ type: String, default: null, trim: true })
  note: string | null;
}

export const NovedadLoteSchema = SchemaFactory.createForClass(NovedadLote);

/**
 * One unit's computed-but-not-yet-issued invoice. Everything Factura needs
 * except what only consolidación assigns: no `number`, no `fullNumber`, no
 * `resolucionId`, no `outstandingBalance`, no `status`.
 */
@Schema({ _id: false })
export class FacturaPreliminar {
  @Prop({ type: Types.ObjectId, ref: Inmueble.name, required: true })
  inmuebleId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  unitCode: string;

  @Prop({ type: Types.ObjectId, ref: Tercero.name, default: null })
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
    type: Types.ObjectId,
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

  // Captured and returned as-is; not yet applied anywhere — applying a
  // discount belongs to the future Recibo (payment application) work, out
  // of this plan's scope.
  @Prop({ required: true, default: 0 })
  earlyPaymentDiscount: number;

  @Prop({ required: true, default: 0 })
  discountGraceDays: number;

  @Prop({ required: true, default: 0 })
  lateInterestRate: number;

  @Prop({ type: Number, default: null })
  lateInterestCap: number | null;

  @Prop({ type: [NovedadLoteSchema], required: true, default: [] })
  adjustments: NovedadLote[];

  @Prop({ type: [FacturaPreliminarSchema], required: true, default: [] })
  preview: FacturaPreliminar[];

  @Prop({
    type: [Types.ObjectId],
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

  @Prop({ type: Types.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;
}

export const LoteFacturacionSchema =
  SchemaFactory.createForClass(LoteFacturacion);

// At most one run in flight per coproperty at a time — a second one would
// make "which lote am I liquidando" ambiguous.
LoteFacturacionSchema.index(
  { coPropertyId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['borrador', 'liquidado'] } },
  },
);
