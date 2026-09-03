// src/database/schemas/numeracion/resolucion-facturacion.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ResolucionFacturacionDocument =
  HydratedDocument<ResolucionFacturacion>;

/**
 * A tax-authority authorisation to issue invoices: a prefix and a numeric range,
 * valid for a period.
 *
 * Every coproperty has its own tax id, so every one has its own resolution,
 * prefix and consecutive — numbering is **never** global across buildings.
 *
 * This entity is what reconciles two things that sound contradictory: the
 * consecutive does not reset, *and* accountants often request a fresh
 * resolution each year with a different prefix. Both are true, because the
 * counter lives inside a resolution. A new one may continue the numbering or
 * start its own range; the model does not have to choose.
 *
 * Only sales invoices are numbered from here. Receipts and notes carry internal
 * consecutives — see ConsecutivoDocumento.
 */
@Schema({ timestamps: true, collection: 'resoluciones_facturacion' })
export class ResolucionFacturacion {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  /** The authorisation number as the tax authority issued it. */
  @Prop({ required: true, trim: true })
  resolutionNumber: string;

  /** Printed before the number, e.g. "CONJ-2026". May be empty. */
  @Prop({ required: true, trim: true, default: '' })
  prefix: string;

  /** Human-readable document name, e.g. "Cobro Expensas Comunes". */
  @Prop({ type: String, default: null, trim: true })
  displayName: string | null;

  /** Free-text accounting voucher code, e.g. "02". */
  @Prop({ type: String, default: null, trim: true })
  accountingVoucherCode: string | null;

  /** Reserved for future mandatory DIAN electronic invoicing consecutive. */
  @Prop({ type: Number, default: null })
  electronicNumber: number | null;

  @Prop({ required: true })
  rangeFrom: number;

  @Prop({ required: true })
  rangeTo: number;

  /**
   * The next number to hand out. Starts at `rangeFrom` and only ever moves
   * forward, one document at a time — see NumeracionService for why it is
   * incremented by the database and never computed from a count.
   */
  @Prop({ required: true })
  nextNumber: number;

  @Prop({ required: true })
  validFrom: Date;

  /** Null where the authorisation carries no expiry. */
  @Prop({ type: Date, default: null })
  validUntil: Date | null;

  /**
   * Only one resolution per coproperty may be active at a time — the one new
   * invoices draw from. Superseded ones stay forever: their numbers are printed
   * on documents that must remain explicable years later.
   */
  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  status: 'active' | 'inactive';
}

export const ResolucionFacturacionSchema = SchemaFactory.createForClass(
  ResolucionFacturacion,
);

// Two active resolutions in one building would make the number a coin flip.
ResolucionFacturacionSchema.index(
  { coPropertyId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
