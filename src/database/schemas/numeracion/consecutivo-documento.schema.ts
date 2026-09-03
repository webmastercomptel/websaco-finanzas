// src/database/schemas/numeracion/consecutivo-documento.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ConsecutivoDocumentoDocument =
  HydratedDocument<ConsecutivoDocumento>;

/** Document types this system issues. */
export const TIPOS_DOCUMENTO = ['FV', 'RC', 'NC', 'ND', 'NT'] as const;
export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number];

/**
 * The running number for a document type within one coproperty.
 *
 * Covers everything except sales invoices, whose numbers come from a tax
 * authorisation instead (see ResolucionFacturacion). Receipts, credit notes,
 * debit notes and accounting entries are internal documents: they still need a
 * gapless, per-building consecutive, but no external range to stay inside.
 *
 * A counter row rather than "count the documents and add one": counting races
 * with itself the moment two people save at once, and two documents sharing a
 * number is the kind of error an auditor finds and nobody can undo.
 */
@Schema({ timestamps: true, collection: 'consecutivos_documento' })
export class ConsecutivoDocumento {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  // `type: String` is not optional here: the declared type is a union of string
  // literals, which @nestjs/mongoose cannot infer, and it fails at schema load
  // rather than at compile time.
  @Prop({ type: String, required: true, enum: TIPOS_DOCUMENTO })
  documentType: TipoDocumento;

  @Prop({ required: true, trim: true, default: '' })
  prefix: string;

  /** Human-readable document name, e.g. "Recibo de Caja". */
  @Prop({ type: String, default: null, trim: true })
  displayName: string | null;

  /** Free-text accounting voucher code, e.g. "02". */
  @Prop({ type: String, default: null, trim: true })
  accountingVoucherCode: string | null;

  /** Reserved for future mandatory DIAN electronic invoicing consecutive. */
  @Prop({ type: Number, default: null })
  electronicNumber: number | null;

  /** The next number to hand out. Moves forward only. */
  @Prop({ required: true, default: 1 })
  nextNumber: number;
}

export const ConsecutivoDocumentoSchema =
  SchemaFactory.createForClass(ConsecutivoDocumento);

// One counter per type per building. A second row would silently split the
// sequence in two, and both halves would look correct on their own.
ConsecutivoDocumentoSchema.index(
  { coPropertyId: 1, documentType: 1 },
  { unique: true },
);
