// src/database/schemas/contabilidad/cuenta-contable.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
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
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  copropiedadId: Types.ObjectId;

  /** e.g. "11050501" */
  @Prop({ required: true, trim: true })
  codigo: string;

  /** e.g. "Caja General" */
  @Prop({ required: true, trim: true })
  nombre: string;

  /** "Tercero" column — whether this account requires a Tercero reference. */
  @Prop({ required: true, default: false })
  requiereTercero: boolean;

  /** "Banco" column — whether this account represents a bank account, e.g.
   *  to offer as the destination account when posting a Recibo de Caja. */
  @Prop({ required: true, default: false })
  esBanco: boolean;

  /** "Flujo Caja" column — cash-flow flag. */
  @Prop({ required: true, default: false })
  flujoCaja: boolean;

  /** "Centro Utilidad" column. */
  @Prop({ required: true, default: false })
  centroUtilidad: boolean;

  /** "Centro Destino" column. */
  @Prop({ required: true, default: false })
  centroDestino: boolean;

  /** "Doc. Cruce" column — whether this account requires a cross-document. */
  @Prop({ required: true, default: false })
  requiereDocumentoCruce: boolean;

  /** "Aplica Impuesto" column — whether `tasaImpuesto` applies at all. */
  @Prop({ required: true, default: false })
  aplicaImpuesto: boolean;

  /** "tasa %" */
  @Prop({ required: true, default: 0, min: 0, max: 100 })
  tasaImpuesto: number;

  @Prop({ required: true, default: true })
  activo: boolean;
}

export const CuentaContableSchema =
  SchemaFactory.createForClass(CuentaContable);

// Duplicate code within one building is a data-entry mistake.
CuentaContableSchema.index({ copropiedadId: 1, codigo: 1 }, { unique: true });
