// src/modules/actividades/actividades.mapper.ts
import { Types } from 'mongoose';
import type { Actividad } from '../../contracts';
import type { ActividadDocument } from '../../database/schemas/administracion/actividad.schema';
import { toIso } from '../../common/utils/mapper.utils';
import type { ActualizarActividadDto } from './dto/actualizar-actividad.dto';
import type { CrearActividadDto } from './dto/guardar-actividad.dto';

/**
 * Maps an Actividad document to the API contract. Persisted enum values already
 * ARE the contract values. `asistiendo` is only set when the caller is known
 * (the resident portal passes its account id); the staff list leaves it out,
 * and the attendee ids themselves are never exposed, only their count.
 */
export const toActividad = (
  doc: ActividadDocument,
  cuentaId?: string,
): Actividad => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  titulo: doc.titulo,
  descripcion: doc.descripcion,
  categoria: doc.categoria,
  fecha: toIso(doc.fecha) ?? '',
  horario: doc.horario,
  ubicacion: doc.ubicacion,
  imagen: doc.imagenUrl,
  destacado: doc.destacado,
  tags: doc.tags,
  asistentes: doc.participantesIds.length,
  capacidad: doc.capacidad,
  estado: doc.estado,
  organizador: doc.organizador,
  ...(cuentaId !== undefined && {
    asistiendo: doc.participantesIds.some((id) => id.toString() === cuentaId),
  }),
});

/**
 * Builds the document fields for a new activity. `copropiedadId` comes from the
 * request context and `codigo` from the service; the attendee list always
 * starts empty.
 */
export const desdeCrearDto = (
  dto: CrearActividadDto,
  copropiedadId: Types.ObjectId,
) => ({
  copropiedadId,
  titulo: dto.titulo,
  descripcion: dto.descripcion ?? '',
  categoria: dto.categoria,
  fecha: new Date(dto.fecha),
  horario: dto.horario ?? '',
  ubicacion: dto.ubicacion ?? '',
  imagenUrl: dto.imagen ?? null,
  destacado: dto.destacado ?? false,
  tags: dto.tags ?? [],
  capacidad: dto.capacidad ?? 0,
  estado: dto.estado ?? 'proximo',
  organizador: dto.organizador ?? '',
});

/** Builds a partial `$set` from an update payload: only the fields the client sent. */
export const desdeActualizarDto = (
  dto: ActualizarActividadDto,
): Record<string, unknown> => {
  const cambios: Record<string, unknown> = {};
  if (dto.titulo !== undefined) cambios.titulo = dto.titulo;
  if (dto.descripcion !== undefined) cambios.descripcion = dto.descripcion;
  if (dto.categoria !== undefined) cambios.categoria = dto.categoria;
  if (dto.fecha !== undefined) cambios.fecha = new Date(dto.fecha);
  if (dto.horario !== undefined) cambios.horario = dto.horario;
  if (dto.ubicacion !== undefined) cambios.ubicacion = dto.ubicacion;
  if (dto.imagen !== undefined) cambios.imagenUrl = dto.imagen;
  if (dto.destacado !== undefined) cambios.destacado = dto.destacado;
  if (dto.tags !== undefined) cambios.tags = dto.tags;
  if (dto.capacidad !== undefined) cambios.capacidad = dto.capacidad;
  if (dto.estado !== undefined) cambios.estado = dto.estado;
  if (dto.organizador !== undefined) cambios.organizador = dto.organizador;
  return cambios;
};
