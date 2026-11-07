// src/database/schemas/administracion/pqr.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PqrDocument = HydratedDocument<Pqr>;

/**
 * Persisted values equal the API contract values: no translation step between
 * the collection and the wire. Runtime arrays (not just types) because the DTOs
 * validate against the same lists the schema enforces.
 */
export const TIPOS_PQR = [
  'peticiones',
  'quejas',
  'reclamos',
  'sugerencias',
  'felicitaciones',
  'denuncias',
] as const;
export type TipoPqr = (typeof TIPOS_PQR)[number];

/**
 * `urgente` is a STATUS here (the board's red column), not a priority.
 * `cerrado` is terminal and only the nightly sweep produces it: a person can
 * move a PQR up to `resuelto`, never straight to `cerrado`.
 */
export const ESTADOS_PQR = [
  'urgente',
  'en_revision',
  'pendiente',
  'resuelto',
  'cerrado',
] as const;
export type EstadoPqr = (typeof ESTADOS_PQR)[number];

/** The states a person may set; `cerrado` is reserved for the nightly sweep. */
export const ESTADOS_PQR_ASIGNABLES = [
  'urgente',
  'en_revision',
  'pendiente',
  'resuelto',
] as const;

export const PRIORIDADES_PQR = ['alta', 'media', 'normal', 'baja'] as const;
export type PrioridadPqr = (typeof PRIORIDADES_PQR)[number];

/**
 * What a client may send as a priority: the four real ones plus `urgente`, a
 * legacy alias (it is a status, not a priority) that the mapper turns into
 * `alta` instead of failing an old client.
 */
export const PRIORIDADES_PQR_ENTRADA = [...PRIORIDADES_PQR, 'urgente'] as const;

/**
 * An attachment is `pendiente` from the moment the backend hands out the signed
 * upload URL until it has verified the object really landed in storage
 * (`listo`). Spanish values; the system this was ported from stored and served
 * `pending` / `ready`.
 */
export const ESTADOS_ADJUNTO_PQR = ['pendiente', 'listo'] as const;
export type EstadoAdjuntoPqr = (typeof ESTADOS_ADJUNTO_PQR)[number];

/** Who reported it, frozen as text: the history must read the same after a rename. */
@Schema({ _id: false })
export class ResidentePqr {
  @Prop({ default: '' })
  nombre: string;

  @Prop({ default: '' })
  rol: string;
}

/** A file attached to a PQR as evidence. Its bytes live in the storage bucket. */
@Schema({ _id: true })
export class AdjuntoPqr {
  /** Present on every stored subdocument; declared (no `@Prop`) so reads are typed. */
  _id: Types.ObjectId;

  /** `imagen` / `pdf` / `docx` / `xlsx` / `archivo`, derived from the MIME type. */
  @Prop({ required: true })
  tipo: string;

  @Prop({ required: true })
  nombre: string;

  @Prop({ type: String, default: null })
  url: string | null;

  /** Object path inside the bucket; the backend owns it, a client never picks it. */
  @Prop({ type: String, default: null })
  rutaAlmacenamiento: string | null;

  @Prop({
    type: String,
    enum: ESTADOS_ADJUNTO_PQR,
    default: 'listo',
  })
  estado: EstadoAdjuntoPqr;
}

/** One reply on the PQR thread, by staff or by the resident who filed it. */
@Schema({ _id: true })
export class SeguimientoPqr {
  _id: Types.ObjectId;

  /** The writer's display name frozen at the time, never a client-supplied value. */
  @Prop({ required: true })
  autor: string;

  @Prop({ required: true })
  mensaje: string;

  @Prop({ required: true, default: () => new Date() })
  fecha: Date;
}

/**
 * A petition, complaint or claim (PQR) of one coproperty. Tenant-owned: every
 * query carries `copropiedadId`. `codigo` (`PQR-001`) comes from a sequence
 * global across coproperties, as in the system this was ported from, hence the
 * unscoped unique index.
 *
 * `autorId` is the resident account that filed it through the portal; it is
 * null when staff registered it on someone's behalf, and it is what scopes a
 * resident to "my PQRs".
 */
@Schema({ timestamps: true, collection: 'adm_pqr', versionKey: false })
export class Pqr {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Account', default: null })
  autorId: Types.ObjectId | null;

  @Prop({ required: true })
  codigo: string;

  @Prop({ required: true })
  titulo: string;

  /** Short summary (the list card). */
  @Prop({ default: '' })
  descripcion: string;

  @Prop({ default: '' })
  descripcionCompleta: string;

  @Prop({ default: '' })
  categoria: string;

  @Prop({ type: String, required: true, enum: TIPOS_PQR })
  tipo: TipoPqr;

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_PQR,
    default: 'pendiente',
  })
  estado: EstadoPqr;

  @Prop({
    type: String,
    required: true,
    enum: PRIORIDADES_PQR,
    default: 'normal',
  })
  prioridad: PrioridadPqr;

  /** Unit code as typed in the unit register (`A-101`), not a reference. */
  @Prop({ default: '' })
  unidad: string;

  @Prop({ type: ResidentePqr, default: () => ({}) })
  residente: ResidentePqr;

  /** Mutated only through atomic operators (see the service). */
  @Prop({ type: [AdjuntoPqr], default: [] })
  archivosAdjuntos: AdjuntoPqr[];

  /** Mutated only through atomic `$push` (see the service). */
  @Prop({ type: [SeguimientoPqr], default: [] })
  seguimientos: SeguimientoPqr[];

  @Prop({ type: Types.ObjectId, ref: 'Tecnico', default: null })
  tecnicoId: Types.ObjectId | null;
}

export const PqrSchema = SchemaFactory.createForClass(Pqr);
PqrSchema.index({ codigo: 1 }, { unique: true });
PqrSchema.index({ copropiedadId: 1, estado: 1 });
PqrSchema.index({ copropiedadId: 1, tipo: 1 });
PqrSchema.index({ copropiedadId: 1, createdAt: -1 });
// "My PQRs" of a resident.
PqrSchema.index({ copropiedadId: 1, autorId: 1, createdAt: -1 });
// The nightly sweep: resolved PQRs untouched for days, across coproperties.
PqrSchema.index({ estado: 1, updatedAt: 1 });
// "Does this technician still have open work?" before deleting it.
PqrSchema.index({ copropiedadId: 1, tecnicoId: 1 });
