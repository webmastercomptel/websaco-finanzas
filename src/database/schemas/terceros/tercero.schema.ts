// src/database/schemas/terceros/tercero.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type TerceroDocument = HydratedDocument<Tercero>;

/**
 * A person or company the system bills, collects from, or names on a document.
 *
 * Kept apart from `Inmueble` — the system this replaces folds the two together,
 * with the owner's name and tax id stored on the unit itself. That has one
 * quiet, expensive consequence: when a unit changes hands and someone edits the
 * name, every past invoice starts showing the new owner. History rewrites
 * itself, which is exactly what the audit law forbids.
 *
 * Separated, the same edit is harmless, because issued documents keep a frozen
 * copy of the party they were made out to. Correcting a typo today must never
 * change what a receipt from two years ago says.
 *
 * A `Tercero` is DATA ABOUT a person, never a user of this system. Only the
 * administrator of a coproperty signs in here; unit owners and tenants never
 * do. So this record carries no identity, no credentials and no permissions,
 * and its `email` is where a document gets sent, not a way to log in. Anything
 * shaped like a resident portal — "my invoices", self-service payment, an owner
 * login — is outside this product.
 */
@Schema({ timestamps: true, collection: 'terceros' })
export class Tercero {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  /** Natural person or legal entity — decides which name fields apply. */
  @Prop({ required: true, enum: ['natural', 'juridica'], default: 'natural' })
  personType: 'natural' | 'juridica';

  /**
   * Display name: full name for a person, trade name for a company.
   *
   * One field rather than first/last name: a company has no surname, and the
   * split forces every screen and every document to branch on personType just
   * to print a name.
   */
  @Prop({ required: true, trim: true })
  name: string;

  /** CC, NIT, CE, passport. Free text — the catalogue varies by country. */
  @Prop({ type: String, default: null, trim: true })
  identificationType: string | null;

  @Prop({ type: String, default: null, trim: true })
  identificationNumber: string | null;

  /** Verification digit, apart from the number. Same reasoning as Copropiedad. */
  @Prop({ type: String, default: null, trim: true })
  identificationVerificationDigit: string | null;

  @Prop({ type: String, default: null, trim: true })
  email: string | null;

  @Prop({ type: String, default: null, trim: true })
  phone: string | null;

  @Prop({ type: String, default: null, trim: true })
  address: string | null;

  @Prop({ type: String, default: null, trim: true })
  city: string | null;

  /** Subject to withholding at source. */
  @Prop({ required: true, default: false })
  withholdsIncomeTax: boolean;

  /** Subject to municipal industry-and-commerce withholding. */
  @Prop({ required: true, default: false })
  withholdsLocalTax: boolean;

  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  status: 'active' | 'inactive';
}

export const TerceroSchema = SchemaFactory.createForClass(Tercero);

// The same person may appear in two coproperties as two records — they are
// different customers of different buildings. Uniqueness is therefore scoped to
// the tenant, and only when an identification number is actually known: a
// building often loads units before it has the owner's papers, and a global
// unique index would let exactly one of those blanks exist.
TerceroSchema.index(
  { coPropertyId: 1, identificationNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { identificationNumber: { $type: 'string' } },
  },
);
