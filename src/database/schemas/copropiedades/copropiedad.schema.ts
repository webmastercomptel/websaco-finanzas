// src/database/schemas/copropiedades/copropiedad.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { EntidadAdministradora } from '../entidades/entidad-administradora.schema';
import { comoNombrePropio } from '../../../common/utils/nombre-propio';

export type CopropiedadDocument = HydratedDocument<Copropiedad>;

/**
 * A building this system bills for. Also the tenant: nearly every other
 * collection carries a `copropiedadId` and is filtered by it.
 *
 * Finanzas owns this collection outright — the product is sold on its own, so
 * a client may have no other system to take a catalog from.
 *
 * Persistence and the API are both Spanish — see "the contract law" in
 * CLAUDE.md. A mapper still sits between the two, but its job is type
 * conversion and composing live-read fields, never language translation.
 */
@Schema({ timestamps: true, collection: 'copropiedades' })
export class Copropiedad {
  /** Human-readable identifier, e.g. "COP-001". What people say out loud. */
  @Prop({ required: true, unique: true, trim: true })
  codigo: string;

  @Prop({ required: true, trim: true, set: comoNombrePropio })
  nombre: string;

  /**
   * Colombian tax id, stored WITHOUT the verification digit, which lives apart
   * in `digitoVerificacion`. Keeping them in one string is what forces every
   * consumer to re-split it, and they will not all split it the same way.
   */
  @Prop({ type: String, default: null, trim: true })
  nit: string | null;

  /** Single digit that closes the NIT. Null while the NIT itself is unknown. */
  @Prop({ type: String, default: null, trim: true })
  digitoVerificacion: string | null;

  @Prop({ type: String, default: null, trim: true })
  direccion: string | null;

  @Prop({ type: String, default: null, trim: true })
  ciudad: string | null;

  @Prop({ type: String, default: null, trim: true })
  telefono: string | null;

  @Prop({ type: String, default: null, trim: true })
  email: string | null;

  /**
   * Whether the WebSACO mark prints on this coproperty's own financial
   * documents (Factura, Recibo, Nota Crédito/Débito/Contable/Anticipo) —
   * see `EncabezadoDocumento`'s own docblock for the layout and which
   * document types read this. Default true so every coproperty that
   * existed before this field was added keeps printing exactly what
   * shipped when the logo was first added to those documents (product
   * decision, 2026-09-19) — this field is an opt-OUT, not an opt-in.
   */
  @Prop({ required: true, default: true })
  mostrarLogo: boolean;

  /**
   * The company that administers this building, when one does. Null when it
   * is administered directly — which is why this is nullable rather than
   * required — but "directly" never means unattended: a real person still
   * runs it, just without a company between them and the building. See
   * `nombreAdministrador` below for what that null case actually looks like.
   *
   * Assignments made at the company level reach every building pointing here,
   * so moving a building between companies changes who can operate it without
   * anyone editing a single person's access.
   */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: EntidadAdministradora.name,
    default: null,
    index: true,
  })
  entidadId: Types.ObjectId | null;

  /**
   * An internal note for when there is no managing company on file — e.g.
   * "Junta de copropietarios", "Portería". Plain text, and only a label: it
   * grants nothing and names no one in particular.
   *
   * This is NOT how a directly-administered building gets a real
   * administrator. That is a person — an `Account`, provisioned through
   * Usuarios — holding an `Asignacion` with `alcance: 'copropiedad'` pointing
   * here. There is always somebody running a building; without a managing
   * company it is simply a named individual instead of one reached through a
   * company's portfolio, never nobody.
   */
  @Prop({ type: String, default: null, trim: true })
  nombreAdministrador: string | null;

  /**
   * Inactive means "stop billing it", not "delete it": its invoices and
   * receipts must stay readable forever. Nothing here removes a coproperty,
   * for the same reason nothing removes a financial document.
   */
  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  estado: 'active' | 'inactive';

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
  usaGestionEdificios: boolean;

  /**
   * This coproperty's `_id` in the building-management system (24-hex
   * ObjectId string, stored trimmed and lowercase). The only identity sent
   * when publishing to that system — the NIT is ambiguous on its side.
   *
   * Invariant kept by `CopropiedadesService`: non-null if and only if
   * `usaGestionEdificios` is true. Legacy documents lack the key entirely;
   * the mapper reads those as null.
   *
   * Unique when set: no two coproperties may hold the same id (the inbound
   * holders pull resolves a coproperty BY this id, so a duplicate would make
   * it ambiguous). Enforced twice — a write-time check in
   * `CopropiedadesService` (409 with a sentence) and the partial unique index
   * declared at the bottom of this file (closes the race). The index ignores
   * `null`/absent values, so unlinked coproperties never collide. It is
   * created by `scripts/migrate-copropiedad-websaco3-id-index.js`, which
   * lists duplicates first: boot-time creation fails SILENTLY when
   * duplicates exist, so the app must never depend on it being there.
   */
  @Prop({ type: String, default: null, trim: true, lowercase: true })
  websaco3CopropiedadId: string | null;

  /**
   * The `_id` of the Empresa in Comptable that keeps this coproperty's books
   * (24-hex ObjectId string, stored trimmed and lowercase). Having it is the
   * whole authorization for "Interfaz a Comptable": no extra flag. Null for
   * coproperties whose books live elsewhere (they keep the CSV export).
   * Legacy documents lack the key; the mapper reads those as null.
   *
   * Validated against Comptable (signed GET) by `CopropiedadesService` every
   * time it CHANGES, and unique when set — one Empresa per coproperty, same
   * double enforcement as `websaco3CopropiedadId`: a write-time 409 plus the
   * partial unique index at the bottom of this file, created by
   * `scripts/migrate-copropiedad-comptable-id-index.js` (boot-time creation
   * fails silently on duplicates).
   */
  @Prop({ type: String, default: null, trim: true, lowercase: true })
  comptableEmpresaId: string | null;

  /**
   * Free-text receivables account every consolidated invoice for this
   * building debits — same reasoning as ConceptoCobro.cuentaCreditoId.
   */
  @Prop({ type: String, default: null, trim: true })
  cuentaContableCartera: string | null;

  /**
   * Free-text liability account for money received but not yet applied to
   * any document — a Recibo's anticipo. Same reasoning and shape as
   * `cuentaContableCartera`; `construirAsientoRecibo` (asiento.builder.ts)
   * credits this account for a Recibo's `unappliedAmount`.
   */
  @Prop({ type: String, default: null, trim: true })
  cuentaAnticipos: string | null;

  /**
   * Free-text expense/contra-revenue account debited when a Nota Crédito is
   * issued — same reasoning and shape as `cuentaContableCartera`/
   * `cuentaAnticipos`. `construirAsientoCruce` (asiento.builder.ts) debits
   * this account for a Nota Crédito's full `montoTotal`.
   */
  @Prop({ type: String, default: null, trim: true })
  cuentaDevoluciones: string | null;

  /**
   * Free-text revenue account credited when a Nota Débito is issued —
   * `construirMovimientos` (asiento.builder.ts) credits this account for
   * the Nota Débito's `total`. Same reasoning as the other account fields.
   */
  @Prop({ type: String, default: null, trim: true })
  cuentaNotasDebito: string | null;

  // ── Parámetros de Facturación (§4) ──────────────────────────────

  @Prop({ required: true, default: false })
  descuentoHabilitado: boolean;

  @Prop({ required: true, default: 0 })
  descuentoPorcentaje: number;

  @Prop({ required: true, default: 0 })
  descuentoValorFijo: number;

  @Prop({ required: true, default: 0 })
  descuentoDiasGracia: number;

  @Prop({ required: true, default: false })
  descuentoAplicaConMora: boolean;

  @Prop({ required: true, default: false })
  moraHabilitada: boolean;

  @Prop({ required: true, default: 0 })
  moraTasaInteres: number;

  /**
   * Minimum overdue balance a unit must owe before mora is calculated at
   * all — NOT a ceiling on the mora amount. Below this, `construirPreview()`
   * (lotes.service.ts) charges nothing rather than a token amount on a
   * trivial balance. Null means no threshold: mora is always calculated
   * when `moraHabilitada`. Name kept as `ValorLimite` for now — the value it
   * limits changed (from "how much mora" to "whether mora applies"), the
   * field itself did not move.
   */
  @Prop({ type: Number, default: null })
  moraValorLimite: number | null;

  @Prop({ type: String, default: null, trim: true })
  cuentaBancariaDefecto: string | null;

  @Prop({ type: String, default: null, trim: true })
  notasFacturacion: string | null;

  /**
   * Cost centre for accounting purposes — one per coproperty, not per unit.
   * Used to live on `Inmueble` (`costCentre`); moved here because a
   * building's cost centre is a facturación-wide parameter, not something
   * that varies unit by unit.
   */
  @Prop({ type: String, default: null, trim: true })
  centroCostoDefecto: string | null;

  /**
   * Cash-flow classification code for accounting purposes — one per
   * coproperty, same reasoning and shape as `centroCostoDefecto` right above.
   * Applied to every journal line whose account has `flujoCaja` set on the
   * chart of accounts.
   */
  @Prop({ type: String, default: null, trim: true })
  flujoCajaCodigo: string | null;

  /**
   * Free-text accounting codes carried over from the predecessor system's
   * "interfaz contable" table (a fixed grid of hardcoded debit/credit
   * columns, deleted from this app — see the note on `navGroups` in
   * `navigation.tsx`). These six survive as coproperty-level parameters
   * because they are not tied to a `ConceptoCobro` line item: they feed the
   * accounting coding of facturación, recibos and notas directly, the same
   * way `cuentaContableCartera`/`cuentaAnticipos`/`cuentaDevoluciones`/
   * `cuentaNotasDebito` above do. Not yet read by `asiento.builder.ts` or any
   * document service — persisted here so "Parámetros de Facturación" has
   * somewhere to keep them until that wiring lands.
   */
  @Prop({ type: String, default: null, trim: true })
  otrosIngresosCuentaDebito: string | null;

  @Prop({ type: String, default: null, trim: true })
  otrosIngresosCuentaCredito: string | null;

  @Prop({ type: String, default: null, trim: true })
  descuentosCuentaDebito: string | null;

  @Prop({ type: String, default: null, trim: true })
  descuentosCuentaCredito: string | null;

  /** "Cuentas de orden" — memorandum/off-balance-sheet accounts. */
  @Prop({ type: String, default: null, trim: true })
  cuentaOrdenDebito: string | null;

  @Prop({ type: String, default: null, trim: true })
  cuentaOrdenCredito: string | null;

  /**
   * The predecessor system's `codeordendb`/`codeordencr` toggle: when 'S',
   * facturación posted the mora-interest charge ("Cargo 2" of the fixed
   * Administración/Intereses/Multas trio) to the "cuentas de orden" above
   * INSTEAD of that concept's own Cargos accounts — every other concept kept
   * coding normally. `construirMovimientos` (asiento.builder.ts) reads this
   * to decide, per line, whether the `tipoConcepto === 'intereses'` line
   * takes its accounts from here instead of from its ConceptoCobro. Default
   * false — most coproperties never used it.
   */
  @Prop({ required: true, default: false })
  usaCuentasOrden: boolean;
}

export const CopropiedadSchema = SchemaFactory.createForClass(Copropiedad);

/**
 * Default name `websaco3CopropiedadId_1`. `$type: 'string'` (not `$exists` or
 * a sparse index) is what lets many coproperties hold `null` side by side: a
 * partial filter cannot use `$ne: null`, but it can match "is a string".
 * Keep name and options identical to the ones in
 * `scripts/migrate-copropiedad-websaco3-id-index.js`, or Mongo reports an
 * IndexOptionsConflict.
 */
CopropiedadSchema.index(
  { websaco3CopropiedadId: 1 },
  {
    unique: true,
    partialFilterExpression: { websaco3CopropiedadId: { $type: 'string' } },
  },
);

/**
 * Default name `comptableEmpresaId_1`, same `$type: 'string'` trick as the
 * index above. Keep name and options identical to the ones in
 * `scripts/migrate-copropiedad-comptable-id-index.js`.
 */
CopropiedadSchema.index(
  { comptableEmpresaId: 1 },
  {
    unique: true,
    partialFilterExpression: { comptableEmpresaId: { $type: 'string' } },
  },
);
