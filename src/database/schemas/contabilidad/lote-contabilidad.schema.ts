import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Account } from '../cuentas/account.schema';

export type LoteContabilidadDocument = HydratedDocument<LoteContabilidad>;

/**
 * One "Adición a Contabilidad" export — a snapshot of exactly which
 * `AsientoContable` rows went into one generation of MOVMES.csv/MOVMESDO.csv,
 * numbered so re-generating never re-exports the same rows twice (each
 * exported `AsientoContable` is stamped with this lote's own `_id`, see
 * `AsientoContable.contabilidadLoteId`). The record itself is the "control"
 * the export exists to provide — a history the user can check against
 * whatever the target accounting system shows it already imported.
 */
@Schema({ timestamps: true, collection: 'lotes_contabilidad' })
export class LoteContabilidad {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ required: true })
  number: number;

  /** The billing period this generation covered — the current period's
   *  bounds at the moment it ran (`LotesFacturacionService.obtenerUltimoConsolidado`),
   *  frozen here for the history view even if a later period opens. */
  @Prop({ required: true })
  periodStart: Date;

  @Prop({ required: true })
  periodEnd: Date;

  /** How many AsientoContable rows (documents) this generation stamped —
   *  MOVMES.csv's own row count. MOVMESDO.csv's row count is the sum of
   *  each of those rows' own entries, not tracked separately here. */
  @Prop({ required: true })
  totalAsientos: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;
}

export const LoteContabilidadSchema =
  SchemaFactory.createForClass(LoteContabilidad);

LoteContabilidadSchema.index({ coPropertyId: 1, number: 1 }, { unique: true });
