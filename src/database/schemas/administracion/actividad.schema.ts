// src/database/schemas/administracion/actividad.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ActividadDocument = HydratedDocument<Actividad>;

/**
 * Persisted values equal the API contract values; runtime arrays so the DTOs
 * validate against the same list the schema enforces.
 */
export const CATEGORIAS_ACTIVIDAD = [
  'integracion',
  'salud',
  'asamblea',
  'cultural',
  'deportivo',
  'operativo',
] as const;
export type CategoriaActividad = (typeof CATEGORIAS_ACTIVIDAD)[number];

export const ESTADOS_ACTIVIDAD = [
  'proximo',
  'en_curso',
  'finalizado',
  'cancelado',
] as const;
export type EstadoActividad = (typeof ESTADOS_ACTIVIDAD)[number];

/**
 * A community activity of one coproperty (yoga class, assembly...) that
 * residents can sign up for. Tenant-owned: every query carries
 * `copropiedadId`. `codigo` (`ACT-001`) comes from a sequence global across
 * coproperties, as in the system this was ported from, hence the unscoped
 * unique index.
 *
 * `capacidad` 0 means NOBODY can register (not "unlimited"): an activity is
 * created closed until the administrator sets a capacity.
 */
@Schema({
  timestamps: true,
  collection: 'adm_actividades',
  versionKey: false,
})
export class Actividad {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ required: true })
  codigo: string;

  @Prop({ required: true })
  titulo: string;

  @Prop({ default: '' })
  descripcion: string;

  @Prop({
    type: String,
    required: true,
    enum: CATEGORIAS_ACTIVIDAD,
    default: 'integracion',
  })
  categoria: CategoriaActividad;

  @Prop({ required: true })
  fecha: Date;

  @Prop({ default: '' })
  horario: string;

  @Prop({ default: '' })
  ubicacion: string;

  @Prop({ type: String, default: null })
  imagenUrl: string | null;

  @Prop({ default: false })
  destacado: boolean;

  @Prop({ type: [String], default: [] })
  tags: string[];

  /** Accounts that signed up. Mutated only through atomic operators (see the service). */
  @Prop({ type: [Types.ObjectId], ref: 'Account', default: [] })
  participantesIds: Types.ObjectId[];

  @Prop({ required: true, default: 0 })
  capacidad: number;

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_ACTIVIDAD,
    default: 'proximo',
  })
  estado: EstadoActividad;

  @Prop({ default: '' })
  organizador: string;
}

export const ActividadSchema = SchemaFactory.createForClass(Actividad);
ActividadSchema.index({ codigo: 1 }, { unique: true });
ActividadSchema.index({ copropiedadId: 1, estado: 1 });
ActividadSchema.index({ copropiedadId: 1, fecha: 1 });
ActividadSchema.index({ copropiedadId: 1, destacado: 1 });
