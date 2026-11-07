// src/database/schemas/administracion/zona.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ZonaDocument = HydratedDocument<Zona>;

/**
 * Persisted values equal the API contract values: no translation step between
 * the collection and the wire. Runtime arrays (not just types) because the DTOs
 * validate against the same lists the schema enforces. The system this was
 * ported from stored `sports` / `social` / `recreational` / `services` /
 * `parking`.
 */
export const TIPOS_ZONA = [
  'deportiva',
  'social',
  'recreativa',
  'servicios',
  'parqueadero',
] as const;
export type TipoZona = (typeof TIPOS_ZONA)[number];

/** The system this was ported from stored `available` / `occupied` / `maintenance` / `closed`. */
export const ESTADOS_ZONA = [
  'disponible',
  'ocupada',
  'mantenimiento',
  'cerrada',
] as const;
export type EstadoZona = (typeof ESTADOS_ZONA)[number];

/**
 * A common area of one coproperty. ONE collection backs both the staff "zonas
 * comunes" screen and the resident "espacios" booking view: `requiereReserva`
 * flags the rows that appear in the latter. Tenant-owned: every query carries
 * `copropiedadId`. `codigo` (`ZC-001`) comes from a sequence global across
 * coproperties, as in the system this was ported from, hence a unique index
 * that is nonetheless scoped by coproperty (also as in the original).
 *
 * The original also had an `availabilityRules` array that no code ever read or
 * wrote (the demo seed stored `[]`); it is not carried over.
 */
@Schema({ timestamps: true, collection: 'adm_zonas', versionKey: false })
export class Zona {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ required: true })
  codigo: string;

  @Prop({ required: true })
  nombre: string;

  @Prop({
    type: String,
    required: true,
    enum: TIPOS_ZONA,
    default: 'social',
  })
  tipo: TipoZona;

  @Prop({ default: '' })
  descripcion: string;

  /** Seats the area holds. Informational: nothing enforces it per booking. */
  @Prop({ required: true, default: 1 })
  capacidad: number;

  /** Free text; an `HH:MM - HH:MM` range in it drives the availability view. */
  @Prop({ default: '' })
  horario: string;

  @Prop({ default: false })
  requiereReserva: boolean;

  @Prop({ type: Number, default: null })
  costo: number | null;

  @Prop({ type: String, default: null })
  imagenUrl: string | null;

  @Prop({ type: [String], default: [] })
  reglas: string[];

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_ZONA,
    default: 'disponible',
  })
  estado: EstadoZona;
}

export const ZonaSchema = SchemaFactory.createForClass(Zona);
ZonaSchema.index({ copropiedadId: 1, codigo: 1 }, { unique: true });
ZonaSchema.index({ copropiedadId: 1, estado: 1 });
ZonaSchema.index({ copropiedadId: 1, tipo: 1 });
ZonaSchema.index({ copropiedadId: 1, requiereReserva: 1 });
