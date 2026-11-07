// src/modules/zonas/zonas.mapper.ts
import { Types } from 'mongoose';
import type { Espacio, ZonaComun } from '../../contracts';
import type { ZonaDocument } from '../../database/schemas/administracion/zona.schema';
import type { ActualizarZonaDto } from './dto/actualizar-zona.dto';
import type { CrearZonaDto } from './dto/guardar-zona.dto';

/**
 * Maps a Zona document to the staff contract. Persisted enum values already ARE
 * the contract values, so nothing is translated.
 */
export const toZonaComun = (doc: ZonaDocument): ZonaComun => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  nombre: doc.nombre,
  tipo: doc.tipo,
  descripcion: doc.descripcion,
  capacidad: doc.capacidad,
  horario: doc.horario,
  estado: doc.estado,
  requiereReserva: doc.requiereReserva,
  costo: doc.costo,
  imagen: doc.imagenUrl,
  reglas: doc.reglas,
});

/**
 * Maps a (bookable) Zona document to the resident contract. It deliberately
 * carries less than `ZonaComun` (no code, no house rules) and collapses
 * `estado` to the booking-oriented pair: only `mantenimiento` is shown as not
 * bookable, as in the system this replaces. `categoria` collapses `tipo` to
 * deportes/social.
 */
export const toEspacio = (doc: ZonaDocument): Espacio => ({
  id: doc._id.toString(),
  nombre: doc.nombre,
  descripcion: doc.descripcion,
  categoria: doc.tipo === 'deportiva' ? 'deportes' : 'social',
  imagen: doc.imagenUrl,
  horario: doc.horario,
  estado: doc.estado === 'mantenimiento' ? 'mantenimiento' : 'disponible',
  costo: doc.costo,
  aforo: doc.capacidad,
});

/**
 * Builds the document fields for a new zone. `copropiedadId` comes from the
 * request context and `codigo` from the service.
 */
export const desdeCrearDto = (
  dto: CrearZonaDto,
  copropiedadId: Types.ObjectId,
) => ({
  copropiedadId,
  nombre: dto.nombre,
  tipo: dto.tipo,
  descripcion: dto.descripcion ?? '',
  capacidad: dto.capacidad ?? 1,
  horario: dto.horario ?? '',
  requiereReserva: dto.requiereReserva ?? false,
  costo: dto.costo ?? null,
  imagenUrl: dto.imagen ?? null,
  reglas: dto.reglas ?? [],
  estado: dto.estado ?? 'disponible',
});

/** Builds a partial `$set` from an update payload: only the fields the client sent. */
export const desdeActualizarDto = (
  dto: ActualizarZonaDto,
): Record<string, unknown> => {
  const cambios: Record<string, unknown> = {};
  if (dto.nombre !== undefined) cambios.nombre = dto.nombre;
  if (dto.tipo !== undefined) cambios.tipo = dto.tipo;
  if (dto.descripcion !== undefined) cambios.descripcion = dto.descripcion;
  if (dto.capacidad !== undefined) cambios.capacidad = dto.capacidad;
  if (dto.horario !== undefined) cambios.horario = dto.horario;
  if (dto.requiereReserva !== undefined) {
    cambios.requiereReserva = dto.requiereReserva;
  }
  if (dto.costo !== undefined) cambios.costo = dto.costo;
  if (dto.imagen !== undefined) cambios.imagenUrl = dto.imagen;
  if (dto.reglas !== undefined) cambios.reglas = dto.reglas;
  if (dto.estado !== undefined) cambios.estado = dto.estado;
  return cambios;
};
