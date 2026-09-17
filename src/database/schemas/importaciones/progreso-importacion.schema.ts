// src/database/schemas/importaciones/progreso-importacion.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export type ProgresoImportacionDocument = HydratedDocument<ProgresoImportacion>;

/** The bulk imports this can track progress for — one row per (coproperty,
 *  kind) pair, so two different imports never overwrite each other's
 *  progress. Closed set, same reasoning as `CATEGORIAS_DOCUMENTO`: adding a
 *  third bulk import means adding a value here, not inventing a new shape. */
export const TIPOS_IMPORTACION = [
  'inmuebles',
  'valores-recurrentes',
  'saldos-iniciales',
] as const;
export type TipoImportacion = (typeof TIPOS_IMPORTACION)[number];

/**
 * A coarse, throttled progress signal for a long-running bulk import — same
 * idea as `LoteFacturacion.progress`, generalised to any bulk import instead
 * of only consolidar(). The importing request writes to this row as it goes
 * (throttled to ~20 writes, never per-row — see `ProgresoImportacionService`)
 * while the frontend polls it via a separate GET, so a request that can take
 * tens of seconds shows "fila X de Y" instead of a frozen button.
 *
 * The row is deleted when the import finishes (success or failure) — its
 * absence IS "nothing in progress", never a zeroed-out row left behind to
 * misread as 0%.
 */
@Schema({ timestamps: true, collection: 'progresos_importacion' })
export class ProgresoImportacion {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: TIPOS_IMPORTACION })
  kind: TipoImportacion;

  @Prop({ required: true, default: 0 })
  current: number;

  @Prop({ required: true, default: 0 })
  total: number;
}

export const ProgresoImportacionSchema =
  SchemaFactory.createForClass(ProgresoImportacion);

ProgresoImportacionSchema.index({ coPropertyId: 1, kind: 1 }, { unique: true });
