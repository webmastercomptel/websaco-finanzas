// src/database/schemas/conceptos/concepto-cobro.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { CuentaContable } from '../contabilidad/cuenta-contable.schema';

export type ConceptoCobroDocument = HydratedDocument<ConceptoCobro>;

/**
 * A billable concept: administration fee, late interest, fines, parking, cable.
 *
 * The system this replaces gives each coproperty twelve generic slots — "Nombre
 * Cargo 1" through 12 — and every screen and table repeats those twelve columns.
 * That design caps a building at twelve concepts, needs a code change for the
 * thirteenth, and spreads the same twelve columns through invoices, receipts,
 * balances and every report.
 *
 * Here they are rows. A building declares as many as it needs, in the order it
 * wants to see them, and the documents that use them carry line items rather
 * than a fixed column per concept. Do not reintroduce concept columns anywhere.
 *
 * The accounting mapping (debit/credit accounts) lives directly on the concept
 * rather than in a separate InterfazContable collection — one row per concept,
 * no extra join.
 */
@Schema({ timestamps: true, collection: 'conceptos_cobro' })
export class ConceptoCobro {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  /**
   * What the system must understand about this concept beyond its name.
   *
   * `administracion` and `intereses` are not just two more concepts: the first
   * is the recurring charge the monthly cycle is built around, and the second
   * is COMPUTED from overdue balances rather than carried as a fixed amount per
   * unit. Code has to find them, and it cannot do that by matching a name a
   * building is free to rewrite.
   *
   * Everything else is `otro` — an ordinary amount someone sets.
   */
  @Prop({
    required: true,
    enum: ['administracion', 'intereses', 'otro'],
    default: 'otro',
  })
  kind: 'administracion' | 'intereses' | 'otro';

  /**
   * VAT rate as a percentage. Zero for almost everything.
   *
   * Ordinary and extraordinary administration fees are civil in nature and
   * carry no VAT — which is why the default is 0 and why the rate lives on the
   * concept rather than on the invoice. A single invoice can mix a fee that is
   * exempt with a charge that is not.
   *
   * Documents copy the rate onto each line when they are issued. Changing it
   * here must never alter what an issued invoice says.
   */
  @Prop({ required: true, default: 0, min: 0, max: 100 })
  taxRate: number;

  /** Display order in listings and documents. Lower comes first. */
  @Prop({ required: true, default: 100 })
  sortOrder: number;

  /** Accounting debit account for this concept's journal entries. */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: CuentaContable.name,
    default: null,
  })
  cuentaDebitoId: Types.ObjectId | null;

  /** Accounting credit account for this concept's journal entries. */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: CuentaContable.name,
    default: null,
  })
  cuentaCreditoId: Types.ObjectId | null;

  /**
   * Accounting account credited for the TAX portion of this concept's
   * charge, when `taxRate > 0` — kept separate from `cuentaCreditoId` so the
   * tax liability never gets folded into ordinary income. Null means no tax
   * account configured; `construirMovimientos` (asiento.builder.ts) falls
   * back to `CUENTA_SIN_ASIGNAR` for the tax line in that case, same as an
   * unconfigured `cuentaCreditoId`.
   */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: CuentaContable.name,
    default: null,
  })
  cuentaImpuestoId: Types.ObjectId | null;

  /**
   * Whether this concept triggers late-interest calculation on overdue
   * balances. Only `intereses` kind typically has this true.
   */
  @Prop({ required: true, default: false })
  liquidaMora: boolean;

  /**
   * Whether this concept may be uploaded as a Novedad via XLS. Default false
   * means existing concepts are excluded until an admin opts them in —
   * real behavior change on deploy (spec §2, §8 Risks).
   */
  @Prop({ required: true, default: false })
  availableAsNovedad: boolean;

  /**
   * System-created charges (Administración, Intereses, Multas) are seeded
   * automatically when a coproperty is born. They cannot be edited or
   * deactivated from the UI — the billing cycle depends on them.
   */
  @Prop({ required: true, default: false })
  isSystem: boolean;
}

export const ConceptoCobroSchema = SchemaFactory.createForClass(ConceptoCobro);

// Two concepts with the same name in one building are a data-entry mistake that
// makes every report ambiguous.
ConceptoCobroSchema.index({ coPropertyId: 1, name: 1 }, { unique: true });

// At most one administration concept and one interest concept per building —
// code looks these up expecting a single answer.
ConceptoCobroSchema.index(
  { coPropertyId: 1, kind: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: { $in: ['administracion', 'intereses'] } },
  },
);
