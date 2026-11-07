import { Types } from 'mongoose';
import { iniciales, toIso } from '../../common/utils/mapper.utils';
import type { Pqr } from '../../contracts';
import type {
  PqrDocument,
  PrioridadPqr,
} from '../../database/schemas/administracion/pqr.schema';
import type { CrearPqrDto } from './dto/guardar-pqr.dto';
import type { CrearPqrPortalDto } from './dto/guardar-pqr-portal.dto';

/**
 * Reads the technician's name off a (possibly populated) `tecnicoId`. A bare
 * ObjectId (never populated) or a technician that no longer matches reads as
 * null: the card then shows "unassigned" instead of failing.
 */
const nombreDelTecnico = (tecnicoId: unknown): string | null => {
  if (
    tecnicoId &&
    typeof tecnicoId === 'object' &&
    !(tecnicoId instanceof Types.ObjectId) &&
    'nombre' in tecnicoId
  ) {
    return String((tecnicoId as { nombre?: string }).nombre ?? '') || null;
  }
  return null;
};

/**
 * Maps a Pqr document to the API contract. Persisted values already ARE the
 * contract values, so this converts ids and dates and derives `iniciales` and
 * `tecnicoAsignado` (the latter needs `tecnicoId` populated). `autorId` is never
 * exposed: it is an internal ownership key, not something a client may read.
 */
export const toPqr = (doc: PqrDocument): Pqr => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  titulo: doc.titulo,
  descripcion: doc.descripcion,
  descripcionCompleta: doc.descripcionCompleta,
  categoria: doc.categoria,
  tipo: doc.tipo,
  estado: doc.estado,
  prioridad: doc.prioridad,
  unidad: doc.unidad,
  residente: {
    nombre: doc.residente?.nombre ?? '',
    iniciales: iniciales(doc.residente?.nombre),
    rol: doc.residente?.rol ?? '',
  },
  fechaCreacion:
    toIso((doc as unknown as { createdAt?: Date }).createdAt) ??
    new Date().toISOString(),
  archivosAdjuntos: (doc.archivosAdjuntos ?? []).map((adjunto) => ({
    id: adjunto._id.toString(),
    tipo: adjunto.tipo,
    nombre: adjunto.nombre,
    url: adjunto.url,
    estado: adjunto.estado,
  })),
  seguimientos: (doc.seguimientos ?? []).map((seguimiento) => ({
    id: seguimiento._id.toString(),
    autor: seguimiento.autor,
    mensaje: seguimiento.mensaje,
    fecha: toIso(seguimiento.fecha) ?? '',
  })),
  tecnicoAsignado: nombreDelTecnico(doc.tecnicoId),
});

/**
 * `urgente` is a STATUS, not a priority (the priority list is
 * alta/media/normal/baja). An older client may still send it as a priority:
 * accept it and normalize to the highest real priority instead of failing.
 */
export const normalizarPrioridad = (
  prioridad?: string,
): PrioridadPqr | undefined =>
  prioridad === 'urgente' ? 'alta' : (prioridad as PrioridadPqr | undefined);

/**
 * Builds the document fields of a PQR registered by staff. `copropiedadId` comes
 * from the request context and `codigo` from the service. No author account:
 * staff file on somebody's behalf, so the reporter is whatever they typed.
 */
export const desdeCrearDto = (
  dto: CrearPqrDto,
  copropiedadId: Types.ObjectId,
) => ({
  copropiedadId,
  autorId: null,
  titulo: dto.titulo,
  descripcion: dto.descripcion,
  descripcionCompleta: dto.descripcionCompleta ?? dto.descripcion,
  categoria: dto.categoria ?? '',
  tipo: dto.tipo,
  estado: dto.estado ?? 'pendiente',
  prioridad: normalizarPrioridad(dto.prioridad) ?? 'normal',
  unidad: dto.unidad?.trim() ?? '',
  residente: {
    nombre: dto.residenteNombre?.trim() ?? '',
    rol: dto.residenteRol?.trim() ?? '',
  },
});

/** What the service resolves about a resident before they may file. */
export interface ReportanteResidente {
  autorId: Types.ObjectId;
  /** Code of one of the caller's own units. */
  unidad: string;
  nombre: string;
  rol: string;
}

/**
 * Builds the document fields of a PQR filed by a resident. Everything about the
 * reporter (author, unit, name, role) comes from the verified `reportante`,
 * never from the payload; the status always starts `pendiente`.
 */
export const desdePortalDto = (
  dto: CrearPqrPortalDto,
  copropiedadId: Types.ObjectId,
  reportante: ReportanteResidente,
) => ({
  copropiedadId,
  autorId: reportante.autorId,
  titulo: dto.titulo,
  descripcion: dto.descripcion,
  descripcionCompleta: dto.descripcionCompleta ?? dto.descripcion,
  categoria: dto.categoria ?? '',
  tipo: dto.tipo,
  estado: 'pendiente' as const,
  prioridad: normalizarPrioridad(dto.prioridad) ?? 'normal',
  unidad: reportante.unidad,
  residente: { nombre: reportante.nombre, rol: reportante.rol },
});
