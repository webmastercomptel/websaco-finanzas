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
   * COMPUTED, not typed directly, whenever the fields below are present —
   * `TercerosService` concatenates `firstName middleName firstLastName
   * secondLastName` (natural) or copies `businessName` (jurídica) into this
   * field on every create/update that touches them. Kept as its own stored
   * field (not a virtual) because every other query/report/document in this
   * app — search, sorting, `TitularCongelado`, invoice PDFs — reads a single
   * display name and must not branch on `personType` to print one.
   *
   * Still directly settable as a fallback for callers with no name parts to
   * offer — the Excel bulk import (`ImportarInmueblesDto`'s `nombreTitular`)
   * loads a unit's holder from one free-text column and has no reliable way
   * to split a Spanish name into parts, so it keeps writing this field
   * directly rather than guessing a split.
   */
  @Prop({ required: true, trim: true })
  name: string;

  /**
   * "Nom1"/"Nom2"/"Ape1"/"Ape2" — only meaningful when `personType` is
   * `natural`. `firstName` and `firstLastName` are the two DIAN requires
   * (PrimerNombre/PrimerApellido); the other two are optional, same as the
   * DIAN schema's OtrosNombres/SegundoApellido. Kept separate from `name` so
   * accounting-interface exports and future DIAN electronic-invoicing files
   * can report each part on its own — `name` alone loses the split once
   * concatenated.
   */
  @Prop({ type: String, default: null, trim: true })
  firstName: string | null;

  @Prop({ type: String, default: null, trim: true })
  middleName: string | null;

  @Prop({ type: String, default: null, trim: true })
  firstLastName: string | null;

  @Prop({ type: String, default: null, trim: true })
  secondLastName: string | null;

  /**
   * "Razón social" — only meaningful when `personType` is `juridica`. Kept
   * apart from `name` for the same reporting reason as the four fields
   * above, even though today the two are identical for a company.
   */
  @Prop({ type: String, default: null, trim: true })
  businessName: string | null;

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

  /**
   * The city's display NAME — unchanged meaning, so every existing
   * screen/PDF that prints `city` keeps working. Picking a city from the
   * DANE catalog (see `CatalogosService`) fills this with that municipio's
   * own `nombre`; `cityCode`/`cityDepartmentCode` below carry the actual
   * DANE codes DIAN electronic invoicing needs, which `city` alone cannot
   * safely be repurposed to hold without breaking every reader that already
   * expects a human name here.
   */
  @Prop({ type: String, default: null, trim: true })
  city: string | null;

  /** DANE municipio code — see the note on `city`. */
  @Prop({ type: String, default: null, trim: true })
  cityCode: string | null;

  /**
   * DANE department code. Technically derivable as `cityCode`'s own first
   * two digits (that is how DANE encodes it), but stored explicitly so
   * nothing downstream has to know that encoding detail to read it.
   */
  @Prop({ type: String, default: null, trim: true })
  cityDepartmentCode: string | null;

  /* ── Electronic invoicing ─────────────────────────────────────
   *
   * What the tax authority requires on an issued invoice, beyond a name and a
   * number. All optional: a building is routinely loaded long before anybody
   * has collected this, and refusing to record a unit until then would stop the
   * work for a field only needed at the moment of issuing.
   *
   * The identification here is separate from the general one above, and stays
   * separate on purpose: they usually match, and when they do not it is because
   * somebody was invoiced under a different document than the one on file.
   * Collapsing them would quietly rewrite one with the other. Empty means "use
   * the general identification".
   */

  @Prop({ type: String, default: null, trim: true })
  einvoiceIdentificationType: string | null;

  @Prop({ type: String, default: null, trim: true })
  einvoiceIdentificationNumber: string | null;

  @Prop({ type: String, default: null, trim: true })
  einvoiceVerificationDigit: string | null;

  /** Economic-activity code (CIIU). */
  @Prop({ type: String, default: null, trim: true })
  ciiuCode: string | null;

  /** Sales-tax regime as the authority names it. */
  @Prop({ type: String, default: null, trim: true })
  salesRegime: string | null;

  /**
   * Fiscal responsibilities, as codes. A party can carry several at once, so
   * this is a list — squeezing them into one string is how the second one gets
   * lost.
   */
  @Prop({ type: [String], required: true, default: [] })
  fiscalResponsibilities: string[];

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
