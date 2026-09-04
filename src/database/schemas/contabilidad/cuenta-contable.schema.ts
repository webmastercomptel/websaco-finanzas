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

  /** "Centro Utilidad" column. */
  @Prop({ required: true, default: false })
  profitCenter: boolean;

  /** "Centro Destino" column. */
  @Prop({ required: true, default: false })
  destinationCenter: boolean;

  /** "Doc. Cruce" column — whether this account requires a cross-document. */
  @Prop({ required: true, default: false })
  requiresCrossDocument: boolean;

  /** "Aplica Impuesto" column — whether `taxRate` applies at all. */
  @Prop({ required: true, default: false })
  appliesTax: boolean;

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
