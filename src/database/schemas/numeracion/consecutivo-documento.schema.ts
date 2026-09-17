// src/database/schemas/numeracion/consecutivo-documento.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ConsecutivoDocumentoDocument =
  HydratedDocument<ConsecutivoDocumento>;

/**
 * The fixed accounting behaviors this system knows about. Closed set — a
 * coproperty cannot invent a new one, because code elsewhere (which
 * collection a document lands in, how it moves cartera) is written against
 * exactly these five.
 */
export const CATEGORIAS_DOCUMENTO = ['FV', 'IN', 'NC', 'ND', 'NT'] as const;
export type CategoriaDocumento = (typeof CATEGORIAS_DOCUMENTO)[number];

/**
 * The running number for one document TYPE within one coproperty.
 *
 * A type is not the same thing as a category. `category` is the fixed
 * accounting behavior (IN = affects cash/bank, credits cartera; NC/ND/NT
 * likewise) — closed, never client-defined. `code` is what the coproperty
 * actually calls the printed document ("RC" for Recibo de Caja, but another
 * building might run "RT" for Recibo de Transacciones Bancarias and "CI" for
 * Comprobante de Ingreso side by side, all three still category `IN`). One
 * building can declare as many codes under one category as it needs; nothing
 * here caps it at one.
 *
 * Covers everything except sales invoices, whose numbers come from a tax
 * authorisation instead (see ResolucionFacturacion) — `category` is never
 * `FV` in a real row, only in the shared enum.
 *
 * A counter row rather than "count the documents and add one": counting races
 * with itself the moment two people save at once, and two documents sharing a
 * number is the kind of error an auditor finds and nobody can undo.
 */
@Schema({ timestamps: true, collection: 'consecutivos_documento' })
export class ConsecutivoDocumento {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  // `type: String` is not optional here: the declared type is a union of string
  // literals, which @nestjs/mongoose cannot infer, and it fails at schema load
  // rather than at compile time.
  @Prop({ type: String, required: true, enum: CATEGORIAS_DOCUMENTO })
  category: CategoriaDocumento;

  /** The client-facing type code, e.g. "RC", "RT", "CI". Unique per building,
   *  across every category — this is the key NumeracionService looks up by. */
  @Prop({ required: true, trim: true })
  code: string;

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

  /**
   * The last number actually issued under this code — 0 while none has been.
   * Moves forward only. `NumeracionService.siguienteDocumento` (and the
   * plain-consecutivo FV fallback in `siguienteFactura`/
   * `reservarBloqueFacturas`) increments this before handing a number out,
   * so the next document issued is always `nextNumber + 1` — a fresh row at
   * 0 hands out 1 first, never 0. Named `nextNumber` for historical reasons;
   * the API contract and UI call it "Último" (see `DocumentoAdmin.numero`).
   */
  @Prop({ required: true, default: 0 })
  nextNumber: number;
}

export const ConsecutivoDocumentoSchema =
  SchemaFactory.createForClass(ConsecutivoDocumento);

// One counter per code per building — a code identifies the row on its own,
// independent of category. A second row for the same code would silently
// split its sequence in two, and both halves would look correct on their own.
ConsecutivoDocumentoSchema.index(
  { coPropertyId: 1, code: 1 },
  { unique: true },
);
