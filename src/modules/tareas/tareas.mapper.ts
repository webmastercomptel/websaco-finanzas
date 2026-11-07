// src/modules/tareas/tareas.mapper.ts
import { Types } from 'mongoose';
import type { Tarea } from '../../contracts';
import type {
  CategoriaTarea,
  EstadoTarea,
  PrioridadTarea,
  TareaDocument,
} from '../../database/schemas/administracion/tarea.schema';
import type { AccountDocument } from '../../database/schemas/cuentas/account.schema';
import { iniciales, toIso } from '../../common/utils/mapper.utils';
import type { CrearTareaDto } from './dto/guardar-tarea.dto';
import type { ActualizarTareaDto } from './dto/actualizar-tarea.dto';

/**
 * True when `asignadosIds` was populated into an Account document rather than
 * left as a bare ObjectId (an account deleted since is dropped by populate).
 */
const esCuentaPoblada = (
  valor: unknown,
): valor is Pick<AccountDocument, 'nombreCompleto'> =>
  valor != null &&
  !(valor instanceof Types.ObjectId) &&
  typeof valor === 'object' &&
  'nombreCompleto' in valor;

/**
 * Maps a Tarea document to the API contract. Persisted enum values already ARE
 * the contract values, so this only converts ids and dates and builds
 * `asignados` from the populated accounts (`asignadosIds` must be populated
 * for them to appear). No account carries a picture, hence `avatar: null`.
 */
export const toTarea = (doc: TareaDocument): Tarea => ({
  id: doc._id.toString(),
  titulo: doc.titulo,
  descripcion: doc.descripcion,
  categoria: doc.categoria,
  prioridad: doc.prioridad,
  estado: doc.estado,
  asignados: ((doc.asignadosIds ?? []) as unknown[])
    .filter(esCuentaPoblada)
    .map((cuenta) => ({
      nombre: cuenta.nombreCompleto,
      iniciales: iniciales(cuenta.nombreCompleto),
      avatar: null,
    })),
  progreso: doc.progreso ?? undefined,
  fechaLimite: toIso(doc.fechaLimite) ?? undefined,
  historial: (doc.historial ?? []).map((entrada) => ({
    accion: entrada.accion,
    usuario: entrada.usuario,
    fecha: toIso(entrada.fecha) ?? '',
  })),
  observaciones: (doc.observaciones ?? []).map((observacion) => ({
    texto: observacion.texto,
    autorId: observacion.autorId.toString(),
    fecha: toIso(observacion.fecha) ?? '',
  })),
});

/** The writable fields of a task, in persistence shape (ids and dates already converted). */
export interface CambiosTarea {
  titulo?: string;
  descripcion?: string;
  categoria?: CategoriaTarea;
  prioridad?: PrioridadTarea;
  estado?: EstadoTarea;
  asignadosIds?: Types.ObjectId[];
  progreso?: number | null;
  fechaLimite?: Date | null;
  orden?: number;
}

/**
 * Builds the document fields for a new task. `copropiedadId` is resolved by
 * the service from the request context, never taken from the payload.
 */
export const desdeCrearDto = (
  dto: CrearTareaDto,
  copropiedadId: Types.ObjectId,
) => ({
  copropiedadId,
  titulo: dto.titulo,
  descripcion: dto.descripcion ?? '',
  categoria: dto.categoria,
  prioridad: dto.prioridad ?? 'normal',
  estado: dto.estado ?? 'pendiente',
  asignadosIds: (dto.asignadosIds ?? []).map((id) => new Types.ObjectId(id)),
  progreso: dto.progreso ?? null,
  fechaLimite: dto.fechaLimite ? new Date(dto.fechaLimite) : null,
  orden: dto.orden ?? 0,
});

/**
 * Builds a partial `$set` from an update payload: only the fields the client
 * sent. Also serves the kanban drag payload (`{ estado, orden }`).
 */
export const desdeActualizarDto = (dto: ActualizarTareaDto): CambiosTarea => {
  const cambios: CambiosTarea = {};
  if (dto.titulo !== undefined) cambios.titulo = dto.titulo;
  if (dto.descripcion !== undefined) cambios.descripcion = dto.descripcion;
  if (dto.categoria !== undefined) cambios.categoria = dto.categoria;
  if (dto.prioridad !== undefined) cambios.prioridad = dto.prioridad;
  if (dto.estado !== undefined) cambios.estado = dto.estado;
  if (dto.asignadosIds !== undefined) {
    cambios.asignadosIds = dto.asignadosIds.map((id) => new Types.ObjectId(id));
  }
  if (dto.progreso !== undefined) cambios.progreso = dto.progreso;
  if (dto.fechaLimite !== undefined) {
    cambios.fechaLimite = dto.fechaLimite ? new Date(dto.fechaLimite) : null;
  }
  if (dto.orden !== undefined) cambios.orden = dto.orden;
  return cambios;
};
