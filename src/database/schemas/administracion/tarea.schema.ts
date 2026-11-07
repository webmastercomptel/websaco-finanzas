// src/database/schemas/administracion/tarea.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TareaDocument = HydratedDocument<Tarea>;

/**
 * The persisted enum values ARE the API contract values: there is no
 * English-to-Spanish translation step between the collection and the wire, so
 * the mapper only converts ids and dates. Runtime arrays (not just types)
 * because the DTOs validate against the same list the schema enforces.
 */
export const CATEGORIAS_TAREA = [
  'limpieza',
  'seguridad',
  'admin',
  'mantenimiento',
] as const;
export type CategoriaTarea = (typeof CATEGORIAS_TAREA)[number];

export const PRIORIDADES_TAREA = ['alta', 'normal', 'baja'] as const;
export type PrioridadTarea = (typeof PRIORIDADES_TAREA)[number];

export const ESTADOS_TAREA = [
  'pendiente',
  'en_progreso',
  'completado',
] as const;
export type EstadoTarea = (typeof ESTADOS_TAREA)[number];

/**
 * One audit line of a task. `usuario` is the actor's display name frozen at the
 * time (not a reference): the history must keep reading the same after the
 * account is renamed.
 */
@Schema({ _id: false })
export class HistorialTarea {
  @Prop({ required: true })
  accion: string;

  @Prop({ required: true })
  usuario: string;

  @Prop({ default: Date.now })
  fecha: Date;
}

/** A free-text note an assignee (or a manager) leaves on a task. */
@Schema({ _id: false })
export class ObservacionTarea {
  @Prop({ required: true })
  texto: string;

  @Prop({ type: Types.ObjectId, ref: 'Account', required: true })
  autorId: Types.ObjectId;

  @Prop({ required: true, default: Date.now })
  fecha: Date;
}

/**
 * A building-management task of one coproperty, shown on the kanban board.
 * Tenant-owned: every query carries `copropiedadId`. The columns are fixed
 * (`estado`), so there is no board entity.
 */
@Schema({ timestamps: true, collection: 'adm_tareas', versionKey: false })
export class Tarea {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ required: true })
  titulo: string;

  @Prop({ default: '' })
  descripcion: string;

  @Prop({ type: String, enum: CATEGORIAS_TAREA, default: 'admin' })
  categoria: CategoriaTarea;

  @Prop({
    type: String,
    required: true,
    enum: PRIORIDADES_TAREA,
    default: 'normal',
  })
  prioridad: PrioridadTarea;

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_TAREA,
    default: 'pendiente',
  })
  estado: EstadoTarea;

  /** Several people can share a task; any of them may complete it. */
  @Prop({ type: [Types.ObjectId], ref: 'Account', default: [] })
  asignadosIds: Types.ObjectId[];

  @Prop({ type: Number, default: null })
  progreso: number | null;

  @Prop({ type: Date, default: null })
  fechaLimite: Date | null;

  /** Position inside its kanban column. */
  @Prop({ required: true, default: 0 })
  orden: number;

  @Prop({ type: [HistorialTarea], default: [] })
  historial: HistorialTarea[];

  @Prop({ type: [ObservacionTarea], default: [] })
  observaciones: ObservacionTarea[];
}

export const TareaSchema = SchemaFactory.createForClass(Tarea);
TareaSchema.index({ copropiedadId: 1, estado: 1, orden: 1 });
TareaSchema.index({ copropiedadId: 1, fechaLimite: 1 });
// "My tasks" for a non-manager: the filter is on the array field.
TareaSchema.index({ asignadosIds: 1 });
