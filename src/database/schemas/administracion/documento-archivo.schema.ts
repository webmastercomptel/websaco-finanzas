// src/database/schemas/administracion/documento-archivo.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ArchivoDocumentoDocument = HydratedDocument<ArchivoDocumento>;

/** The file kind tag the screens show an icon for. `otro` covers everything else. */
export const TIPOS_ARCHIVO = [
  'pdf',
  'docx',
  'xlsx',
  'png',
  'jpg',
  'otro',
] as const;
export type TipoArchivo = (typeof TIPOS_ARCHIVO)[number];

/**
 * `pendiente` = the record exists and a signed upload URL was issued, but the
 * file is not confirmed yet; `listo` = confirmed and usable. Only `pendiente`
 * rows are ever swept by the orphan cron.
 */
export const ESTADOS_ARCHIVO = ['pendiente', 'listo'] as const;
export type EstadoArchivo = (typeof ESTADOS_ARCHIVO)[number];

/**
 * A file of the building's document library. The backend owns the storage path
 * (always under `documentos-administracion/<copropiedadId>/`); the browser PUTs
 * straight to a signed URL and then confirms.
 *
 * Tenant-owned: every query carries `copropiedadId`. `estado` is REQUIRED with
 * no default on purpose: a record written without it (a careless migration)
 * must fail loudly instead of silently becoming a candidate for the cron.
 */
@Schema({
  timestamps: true,
  collection: 'adm_documentos',
  versionKey: false,
})
export class ArchivoDocumento {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'CarpetaDocumento', required: true })
  carpetaId: Types.ObjectId;

  /** `DOC-001`, from a global sequence (same as the system this was ported from). */
  @Prop({ required: true })
  codigo: string;

  @Prop({ required: true })
  nombre: string;

  @Prop({ default: '' })
  mimeType: string;

  @Prop({ type: String, enum: TIPOS_ARCHIVO, default: 'otro' })
  tipo: TipoArchivo;

  @Prop({ default: '' })
  categoria: string;

  @Prop({ type: String, default: null })
  rutaAlmacenamiento: string | null;

  @Prop({ type: String, enum: ESTADOS_ARCHIVO, required: true })
  estado: EstadoArchivo;

  @Prop({ required: true, default: 0 })
  tamanoBytes: number;

  /** Uploader's display name, frozen at upload time. */
  @Prop({ default: '' })
  autorNombre: string;

  @Prop({ default: false })
  destacado: boolean;

  @Prop({ type: [String], default: [] })
  etiquetas: string[];

  @Prop({ type: Types.ObjectId, ref: 'Account', default: null })
  subidoPorId: Types.ObjectId | null;
}

export const ArchivoDocumentoSchema =
  SchemaFactory.createForClass(ArchivoDocumento);
ArchivoDocumentoSchema.index({ codigo: 1 }, { unique: true });
ArchivoDocumentoSchema.index({ copropiedadId: 1, carpetaId: 1, estado: 1 });
// The orphan cron scans every coproperty by state and age.
ArchivoDocumentoSchema.index({ estado: 1, createdAt: 1 });
