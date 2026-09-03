// src/database/schemas/contabilidad/cuenta-contable.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type CuentaContableDocument = HydratedDocument<CuentaContable>;

/**
 * A row in a coproperty's chart of accounts. Colombian propiedad horizontal
 * has no mandated PUC, so the code space is free text — whatever the
 * building's accountant already uses.
 *
 * Inactive, never deleted: same audit law as Entidades, Copropiedades,
 * ConceptoCobro. "Eliminar" in the legacy screen retires an account without
 * breaking any journal entry that already references its code.
 */
@Schema({ timestamps: true, collection: 'cuentas_contables' })
export class CuentaContable {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  /** e.g. "11050501" */
  @Prop({ required: true, trim: true })
  code: string;

  /** e.g. "Caja General" */
  @Prop({ required: true, trim: true })
  name: string;

  /** "Tercero" column — whether this account requires a Tercero reference. */
  @Prop({ required: true, default: false })
  requiresTercero: boolean;

  /** "Flujo Caja" column — cash-flow flag. */
  @Prop({ required: true, default: false })
  cashFlow: boolean;

  /**
   * Free-text code for Centro de Utilidad. Same value for every operation
   * that uses this account — property of the ACCOUNT, not per-transaction.
   * Consuming when building a Movimiento is future engine work.
   */
  @Prop({ type: String, default: null, trim: true })
  profitCenterCode: string | null;

  /** Same shape and reasoning as profitCenterCode. */
  @Prop({ type: String, default: null, trim: true })
  destinationCenterCode: string | null;

  /** "Doc. Cruce" column — whether this account requires a cross-document. */
  @Prop({ required: true, default: false })
  requiresCrossDocument: boolean;

  /**
   * Free text for tax category — same reasoning as
   * ConceptoCobro.accountingIncomeAccount.
   */
  @Prop({ type: String, default: null, trim: true })
  taxType: string | null;

  /** "tasa %" */
  @Prop({ required: true, default: 0, min: 0, max: 100 })
  taxRate: number;

  @Prop({ required: true, default: true })
  active: boolean;
}

export const CuentaContableSchema =
  SchemaFactory.createForClass(CuentaContable);

// Duplicate code within one building is a data-entry mistake.
CuentaContableSchema.index({ coPropertyId: 1, code: 1 }, { unique: true });
