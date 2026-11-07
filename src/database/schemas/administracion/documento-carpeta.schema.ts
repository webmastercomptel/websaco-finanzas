// src/database/schemas/administracion/documento-carpeta.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CarpetaDocumentoDocument = HydratedDocument<CarpetaDocumento>;

/**
 * Who a folder rule is about. The persisted values ARE the API contract values
 * (no translation step between the collection and the wire).
 *
 * - `rol`: a staff role of THIS coproperty (collection `adm_roles`).
 * - `residentes`: unit holders of the coproperty, who carry no CASL permissions
 *   and therefore no role; they are addressed by how they hold a unit.
 */
export const TIPOS_AUDIENCIA_CARPETA = ['rol', 'residentes'] as const;
export type TipoAudienciaCarpeta = (typeof TIPOS_AUDIENCIA_CARPETA)[number];

/** Which residents a `residentes` rule reaches; `todos` = owners and tenants. */
export const ROLES_RESIDENTE_CARPETA = [
  'propietario',
  'arrendatario',
  'todos',
] as const;
export type RolResidenteCarpeta = (typeof ROLES_RESIDENTE_CARPETA)[number];

/**
 * One rule of a folder's ACL: a tagged union flattened into one subdocument.
 * Exactly one of `rolId` (tipo `rol`) or `rol` (tipo `residentes`) is set; the
 * service enforces that on write. A residents rule can only ever read: unit
 * holders have no write route in this product.
 *
 * There is deliberately no "administer" flag: administering folders and their
 * rules needs the `documentos-administracion.gestionar` permission, which
 * already bypasses every rule, so a per-folder flag would grant nothing.
 */
@Schema({ _id: false })
export class AclCarpetaDocumento {
  @Prop({ type: String, enum: TIPOS_AUDIENCIA_CARPETA, required: true })
  tipo: TipoAudienciaCarpeta;

  @Prop({ type: Types.ObjectId, ref: 'Rol' })
  rolId?: Types.ObjectId;

  @Prop({ type: String, enum: ROLES_RESIDENTE_CARPETA })
  rol?: RolResidenteCarpeta;

  @Prop({ required: true, default: false })
  puedeLeer: boolean;

  @Prop({ required: true, default: false })
  puedeEscribir: boolean;
}

/**
 * A folder of the building's document library. Tenant-owned: every query
 * carries `copropiedadId`. Folders nest through `carpetaPadreId`; a folder with
 * no rules of its own inherits those of the nearest ancestor that has any, and
 * a folder with no rules anywhere in its chain is private (only whoever holds
 * `gestionar` reaches it).
 */
@Schema({
  timestamps: true,
  collection: 'adm_documentos_carpetas',
  versionKey: false,
})
export class CarpetaDocumento {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'CarpetaDocumento', default: null })
  carpetaPadreId: Types.ObjectId | null;

  /** Unique per coproperty (not per parent), so `?carpeta=<slug>` addresses any depth. */
  @Prop({ required: true })
  slug: string;

  @Prop({ required: true })
  nombre: string;

  @Prop({ default: '' })
  descripcion: string;

  @Prop({ default: 'folder' })
  icono: string;

  @Prop({ default: '#64748b' })
  color: string;

  @Prop({ type: [AclCarpetaDocumento], default: [] })
  acls: AclCarpetaDocumento[];
}

export const CarpetaDocumentoSchema =
  SchemaFactory.createForClass(CarpetaDocumento);
CarpetaDocumentoSchema.index({ copropiedadId: 1, slug: 1 }, { unique: true });
CarpetaDocumentoSchema.index({ copropiedadId: 1, carpetaPadreId: 1 });
CarpetaDocumentoSchema.index({ 'acls.rolId': 1 });
