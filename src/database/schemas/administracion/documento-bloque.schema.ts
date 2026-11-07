// src/database/schemas/administracion/documento-bloque.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TIPOS_BLOQUE, type TipoBloque } from './bloque-facturacion.schema';

export type DocumentoBloqueDocument = HydratedDocument<DocumentoBloque> & {
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The PDF of ONE unit, cut out of a `BloqueFacturacion` during ingest and stored
 * as its own object. Tenant-owned: every query carries `copropiedadId`.
 *
 * Stored (not rebuilt per download as the previous system did) for two reasons:
 * a resident gets a short-lived signed URL to a file that holds ONLY their
 * pages, and no download ever has to load the 200 MB original into memory.
 *
 * `tipo` and `periodo` are copied from the block so the resident list is one
 * query; they never change after ingest. Delivery progress is recorded here, per
 * recipient, with `$addToSet` AFTER each delivery succeeded, so sending again
 * only reaches whoever is missing (same design as the announcements).
 */
@Schema({
  timestamps: true,
  collection: 'adm_facturacion_documentos',
  versionKey: false,
})
export class DocumentoBloque {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'BloqueFacturacion', required: true })
  bloqueId: Types.ObjectId;

  /** The unit this document belongs to; the ONLY thing residents are matched on. */
  @Prop({ type: Types.ObjectId, ref: 'Inmueble', required: true })
  inmuebleId: Types.ObjectId;

  /** `Inmueble.codigo` as stored, frozen at ingest for display and file names. */
  @Prop({ required: true })
  codigoInmueble: string;

  @Prop({ type: String, required: true, enum: TIPOS_BLOQUE })
  tipo: TipoBloque;

  @Prop({ required: true })
  periodo: string;

  /** 1-indexed pages of the original that make up this document. */
  @Prop({ type: [Number], default: [] })
  paginas: number[];

  @Prop({ required: true })
  rutaAlmacenamiento: string;

  @Prop({ required: true, default: 0 })
  tamanoBytes: number;

  /** Accounts whose in-app notification was already created (delivery progress). */
  @Prop({ type: [Types.ObjectId], ref: 'Account', default: [] })
  notificadosIds: Types.ObjectId[];

  /** Accounts whose email the provider already accepted (delivery progress). */
  @Prop({ type: [Types.ObjectId], ref: 'Account', default: [] })
  correosEnviadosIds: Types.ObjectId[];
}

export const DocumentoBloqueSchema =
  SchemaFactory.createForClass(DocumentoBloque);
// One document per unit per block: re-running an ingest overwrites, never doubles.
DocumentoBloqueSchema.index(
  { copropiedadId: 1, bloqueId: 1, inmuebleId: 1 },
  { unique: true },
);
// The resident list: "my units' documents of these kinds".
DocumentoBloqueSchema.index({ copropiedadId: 1, inmuebleId: 1, tipo: 1 });
