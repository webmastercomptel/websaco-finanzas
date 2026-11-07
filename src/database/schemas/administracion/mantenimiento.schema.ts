// src/database/schemas/administracion/mantenimiento.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MantenimientoDocument = HydratedDocument<Mantenimiento>;

/**
 * The persisted enum values ARE the API contract values (no translation step),
 * so the mapper only converts ids and dates. Runtime arrays, not just types,
 * because the DTOs validate against the same list the schema enforces.
 */
export const TIPOS_MANTENIMIENTO = ['preventivo', 'correctivo'] as const;
export type TipoMantenimiento = (typeof TIPOS_MANTENIMIENTO)[number];

export const ESTADOS_MANTENIMIENTO = [
  'programado',
  'en_progreso',
  'completado',
  'cancelado',
] as const;
export type EstadoMantenimiento = (typeof ESTADOS_MANTENIMIENTO)[number];

export const PRIORIDADES_MANTENIMIENTO = [
  'urgente',
  'alta',
  'normal',
  'baja',
] as const;
export type PrioridadMantenimiento = (typeof PRIORIDADES_MANTENIMIENTO)[number];

/**
 * Who does the work. Only the name is frozen here: when the provider was picked
 * from the technician catalog the name is a snapshot of it, so the record keeps
 * reading the same after the technician is renamed or deleted.
 */
@Schema({ _id: false })
export class ProveedorMantenimiento {
  @Prop({ required: true })
  nombre: string;
}

/**
 * A scheduled or corrective maintenance job of one coproperty. Tenant-owned:
 * every query carries `copropiedadId`. `codigo` (`MNT-001`) comes from a
 * sequence that is global across coproperties, exactly as in the system this
 * was ported from, which is why its unique index is not scoped by tenant.
 */
@Schema({
  timestamps: true,
  collection: 'adm_mantenimientos',
  versionKey: false,
})
export class Mantenimiento {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ required: true })
  codigo: string;

  @Prop({ required: true })
  titulo: string;

  @Prop({ default: '' })
  descripcion: string;

  @Prop({ type: String, required: true, enum: TIPOS_MANTENIMIENTO })
  tipo: TipoMantenimiento;

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_MANTENIMIENTO,
    default: 'programado',
  })
  estado: EstadoMantenimiento;

  @Prop({
    type: String,
    enum: [...PRIORIDADES_MANTENIMIENTO, null],
    default: null,
  })
  prioridad: PrioridadMantenimiento | null;

  @Prop({ required: true })
  fecha: Date;

  @Prop({ type: String, default: null })
  horario: string | null;

  @Prop({ type: ProveedorMantenimiento, required: true })
  proveedor: ProveedorMantenimiento;

  /** Real link when the provider was picked from the technician catalog; null for a free-typed one. */
  @Prop({ type: Types.ObjectId, ref: 'Tecnico', default: null })
  tecnicoId: Types.ObjectId | null;

  @Prop({ default: '' })
  ubicacion: string;

  @Prop({ type: String, default: null })
  notas: string | null;

  @Prop({ type: Number, default: null })
  costoEstimado: number | null;

  @Prop({ type: Date, default: null })
  completadoEn: Date | null;
}

export const MantenimientoSchema = SchemaFactory.createForClass(Mantenimiento);
MantenimientoSchema.index({ codigo: 1 }, { unique: true });
MantenimientoSchema.index({ copropiedadId: 1, estado: 1 });
MantenimientoSchema.index({ copropiedadId: 1, tipo: 1 });
MantenimientoSchema.index({ copropiedadId: 1, fecha: 1 });
