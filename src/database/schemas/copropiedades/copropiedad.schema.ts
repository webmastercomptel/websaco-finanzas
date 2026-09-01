// src/database/schemas/copropiedades/copropiedad.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EntidadAdministradora } from '../entidades/entidad-administradora.schema';

export type CopropiedadDocument = HydratedDocument<Copropiedad>;

/**
 * A building this system bills for. Also the tenant: nearly every other
 * collection carries a `coPropertyId` and is filtered by it.
 *
 * Finanzas owns this collection outright — the product is sold on its own, so
 * a client may have no other system to take a catalog from.
 *
 * Fields are English (persistence) and reach the client in Spanish through a
 * mapper. See contracts/index.ts.
 */
@Schema({ timestamps: true, collection: 'copropiedades' })
export class Copropiedad {
  /** Human-readable identifier, e.g. "COP-001". What people say out loud. */
  @Prop({ required: true, unique: true, trim: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  /**
   * Colombian tax id, stored WITHOUT the verification digit, which lives apart
   * in `taxIdVerificationDigit`. Keeping them in one string is what forces
   * every consumer to re-split it, and they will not all split it the same way.
   */
  @Prop({ type: String, default: null, trim: true })
  taxId: string | null;

  /** Single digit that closes the NIT. Null while the NIT itself is unknown. */
  @Prop({ type: String, default: null, trim: true })
  taxIdVerificationDigit: string | null;

  @Prop({ type: String, default: null, trim: true })
  address: string | null;

  @Prop({ type: String, default: null, trim: true })
  city: string | null;

  @Prop({ type: String, default: null, trim: true })
  phone: string | null;

  @Prop({ type: String, default: null, trim: true })
  email: string | null;

  /**
   * The company that administers this building, when one does. Null when it
   * is administered directly — which is why this is nullable rather than
   * required — but "directly" never means unattended: a real person still
   * runs it, just without a company between them and the building. See
   * `administratorName` below for what that null case actually looks like.
   *
   * Assignments made at the company level reach every building pointing here,
   * so moving a building between companies changes who can operate it without
   * anyone editing a single person's access.
   */
  @Prop({
    type: Types.ObjectId,
    ref: EntidadAdministradora.name,
    default: null,
    index: true,
  })
  managingEntityId: Types.ObjectId | null;

  /**
   * An internal note for when there is no managing company on file — e.g.
   * "Junta de copropietarios", "Portería". Plain text, and only a label: it
   * grants nothing and names no one in particular.
   *
   * This is NOT how a directly-administered building gets a real
   * administrator. That is a person — an `Account`, provisioned through
   * Usuarios — holding an `Asignacion` with `scope: 'copropiedad'` pointing
   * here. There is always somebody running a building; without a managing
   * company it is simply a named individual instead of one reached through a
   * company's portfolio, never nobody.
   */
  @Prop({ type: String, default: null, trim: true })
  administratorName: string | null;

  /**
   * Inactive means "stop billing it", not "delete it": its invoices and
   * receipts must stay readable forever. Nothing here removes a coproperty,
   * for the same reason nothing removes a financial document.
   */
  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  status: 'active' | 'inactive';

  /**
   * Whether this coproperty ALSO uses the building-management system, and so
   * whether anything is published to it.
   *
   * Stated in this direction on purpose: every coproperty here has Finanzas by
   * definition, so "has Finanzas" would be a field that is always true. Default
   * false — most clients own only this product, and for them the integration is
   * not a disabled feature, it is not part of what they bought.
   */
  @Prop({ required: true, default: false })
  usesBuildingManagement: boolean;

  /**
   * Free-text receivables account every consolidated invoice for this
   * building debits — same reasoning as ConceptoCobro.accountingIncomeAccount.
   */
  @Prop({ type: String, default: null, trim: true })
  receivablesAccount: string | null;

  /**
   * Free-text liability account for money received but not yet applied to
   * any document — a Recibo's anticipo. Same reasoning and shape as
   * `receivablesAccount`; `construirAsientoRecibo` (asiento.builder.ts)
   * credits this account for a Recibo's `unappliedAmount`.
   */
  @Prop({ type: String, default: null, trim: true })
  advancesAccount: string | null;

  /**
   * Free-text expense/contra-revenue account debited when a Nota Crédito is
   * issued — same reasoning and shape as `receivablesAccount`/
   * `advancesAccount`. `construirAsientoCruce` (asiento.builder.ts) debits
   * this account for a Nota Crédito's full `montoTotal`.
   */
  @Prop({ type: String, default: null, trim: true })
  creditNotesAccount: string | null;

  /**
   * Free-text revenue account credited when a Nota Débito is issued —
   * `construirMovimientos` (asiento.builder.ts) credits this account for
   * the Nota Débito's `total`. Same reasoning as the other account fields.
   */
  @Prop({ type: String, default: null, trim: true })
  debitNotesAccount: string | null;
}

export const CopropiedadSchema = SchemaFactory.createForClass(Copropiedad);
