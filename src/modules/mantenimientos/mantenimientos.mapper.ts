// src/modules/mantenimientos/mantenimientos.mapper.ts
import { Types } from 'mongoose';
import type { Mantenimiento } from '../../contracts';
import type { MantenimientoDocument } from '../../database/schemas/administracion/mantenimiento.schema';
import { iniciales, toIso } from '../../common/utils/mapper.utils';
import type { ActualizarMantenimientoDto } from './dto/actualizar-mantenimiento.dto';
import type { CrearMantenimientoDto } from './dto/guardar-mantenimiento.dto';

/**
 * Maps a Mantenimiento document to the API contract. Persisted enum values
 * already ARE the contract values, so this only converts ids and dates and
 * composes `proveedor.iniciales`. Nullable columns become absent keys, as the
 * contract declares them optional.
 */
export const toMantenimiento = (doc: MantenimientoDocument): Mantenimiento => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  titulo: doc.titulo,
  descripcion: doc.descripcion,
  tipo: doc.tipo,
  estado: doc.estado,
  prioridad: doc.prioridad ?? undefined,
  fecha: toIso(doc.fecha) ?? '',
  horario: doc.horario ?? undefined,
  proveedor: {
    nombre: doc.proveedor.nombre,
    iniciales: iniciales(doc.proveedor.nombre),
  },
  tecnicoId: doc.tecnicoId ? doc.tecnicoId.toString() : null,
  ubicacion: doc.ubicacion,
  notas: doc.notas ?? undefined,
  costoEstimado: doc.costoEstimado ?? undefined,
  completadoEn: toIso(doc.completadoEn) ?? undefined,
});

/** A provider resolved server-side: from the technician catalog, or free-typed. */
export interface ProveedorResuelto {
  nombre: string;
  tecnicoId: Types.ObjectId | null;
}

/**
 * Builds the document fields for a new maintenance. `copropiedadId` comes from
 * the request context; `proveedor` is resolved by the service (it may need a
 * catalog lookup), never derived from the payload here. A new maintenance is
 * never completed.
 */
export const desdeCrearDto = (
  dto: CrearMantenimientoDto,
  copropiedadId: Types.ObjectId,
  proveedor: ProveedorResuelto,
) => ({
  copropiedadId,
  titulo: dto.titulo,
  descripcion: dto.descripcion ?? '',
  tipo: dto.tipo,
  estado: dto.estado ?? 'programado',
  prioridad: dto.prioridad ?? null,
  fecha: new Date(dto.fecha),
  horario: dto.horario ?? null,
  proveedor: { nombre: proveedor.nombre },
  tecnicoId: proveedor.tecnicoId,
  ubicacion: dto.ubicacion ?? '',
  notas: dto.notas ?? null,
  costoEstimado: dto.costoEstimado ?? null,
  completadoEn: null,
});

/**
 * Builds a partial `$set` from an update payload: only the fields the client
 * sent. Pass `proveedor` (already resolved) only when `dto.proveedor` was sent.
 */
export const desdeActualizarDto = (
  dto: ActualizarMantenimientoDto,
  proveedor?: ProveedorResuelto,
): Record<string, unknown> => {
  const cambios: Record<string, unknown> = {};
  if (dto.titulo !== undefined) cambios.titulo = dto.titulo;
  if (dto.descripcion !== undefined) cambios.descripcion = dto.descripcion;
  if (dto.tipo !== undefined) cambios.tipo = dto.tipo;
  if (dto.estado !== undefined) cambios.estado = dto.estado;
  if (dto.prioridad !== undefined) cambios.prioridad = dto.prioridad;
  if (dto.fecha !== undefined) cambios.fecha = new Date(dto.fecha);
  if (dto.horario !== undefined) cambios.horario = dto.horario;
  if (proveedor) {
    cambios.proveedor = { nombre: proveedor.nombre };
    cambios.tecnicoId = proveedor.tecnicoId;
  }
  if (dto.ubicacion !== undefined) cambios.ubicacion = dto.ubicacion;
  if (dto.notas !== undefined) cambios.notas = dto.notas;
  if (dto.costoEstimado !== undefined) {
    cambios.costoEstimado = dto.costoEstimado;
  }
  if (dto.completadoEn !== undefined) {
    cambios.completadoEn = new Date(dto.completadoEn);
  }
  return cambios;
};
