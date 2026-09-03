// src/database/schemas/contabilidad/interfaz-contable.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';
import { CuentaContable } from './cuenta-contable.schema';

export type InterfazContableDocument = HydratedDocument<InterfazContable>;

/**
 * Maps a ConceptoCobro (or a special row) to a debit/credit pair of
 * CuentaContable codes. One mapping per cargo, of either kind.
 *
 * This is read/write catalog data only — nothing in asiento.builder.ts
 * consumes it in this spec (§2).
 */
@Schema({ timestamps: true, collection: 'interfaz_contable' })
export class InterfazContable {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ required: true, enum: ['concepto', 'especial'] })
  cargoTipo: 'concepto' | 'especial';

  /** Set when cargoTipo === 'concepto'. */
  @Prop({ type: Types.ObjectId, ref: ConceptoCobro.name, default: null })
  conceptoId: Types.ObjectId | null;

  /** Set when cargoTipo === 'especial'. */
  @Prop({
    type: String,
    enum: ['descuentos', 'interesesOrdenDb'],
    default: null,
  })
  cargoEspecial: 'descuentos' | 'interesesOrdenDb' | null;

  @Prop({
    type: Types.ObjectId,
    ref: CuentaContable.name,
    required: true,
  })
  cuentaDebitoId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: CuentaContable.name,
    required: true,
  })
  cuentaCreditoId: Types.ObjectId;
}

export const InterfazContableSchema =
  SchemaFactory.createForClass(InterfazContable);

// One mapping row per concepto (partial unique).
InterfazContableSchema.index(
  { coPropertyId: 1, conceptoId: 1 },
  { unique: true, partialFilterExpression: { conceptoId: { $ne: null } } },
);

// One mapping row per especial type (partial unique).
InterfazContableSchema.index(
  { coPropertyId: 1, cargoEspecial: 1 },
  {
    unique: true,
    partialFilterExpression: { cargoEspecial: { $ne: null } },
  },
);
