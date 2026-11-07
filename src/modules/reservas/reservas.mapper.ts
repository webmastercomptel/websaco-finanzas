// src/modules/reservas/reservas.mapper.ts
import { Types, type PopulateOptions } from 'mongoose';
import type { Reserva, ReservaSolicitud } from '../../contracts';
import { iniciales, toIso } from '../../common/utils/mapper.utils';
import type {
  EstadoReserva,
  ReservaDocument,
} from '../../database/schemas/administracion/reserva.schema';
import { formatearRangoUtc } from './reservas-horario';

/**
 * Populates the zone's name for `espacio`/`area`. The `match` keeps the lookup
 * inside the tenant: a reference to a zone of another building can never leak
 * its name (it populates as null and reads as an empty name).
 */
export const poblarZona = (copropiedadId: Types.ObjectId): PopulateOptions => ({
  path: 'zonaId',
  select: 'nombre',
  match: { copropiedadId },
});

/** The name off a (possibly populated, possibly nulled) `zonaId`. */
export const nombreDeZona = (zonaId: unknown): string => {
  if (
    zonaId &&
    typeof zonaId === 'object' &&
    !(zonaId instanceof Types.ObjectId) &&
    'nombre' in zonaId &&
    typeof zonaId.nombre === 'string'
  ) {
    return zonaId.nombre;
  }
  return '';
};

/**
 * The display state of `Reserva.estado`: it collapses `rechazada` and
 * `cancelada` into one, exactly as the system this replaces did. The finer
 * state travels in `ReservaSolicitud.estado`.
 */
const ESTADO_VISIBLE: Record<EstadoReserva, Reserva['estado']> = {
  aprobada: 'confirmada',
  pendiente: 'pendiente_aprobacion',
  rechazada: 'cancelada',
  cancelada: 'cancelada',
};

/** A cancelled booking has no row in the approval queue; it is never asked for. */
const ESTADO_SOLICITUD: Partial<
  Record<EstadoReserva, ReservaSolicitud['estado']>
> = {
  pendiente: 'pendiente',
  aprobada: 'aprobada',
  rechazada: 'rechazada',
};

/**
 * Maps a Reserva document to the booking contract. Expects `zonaId` populated
 * (see `poblarZona`) for the area name. The derived `activa`/`franjas` fields
 * stay inside: they are bookkeeping of the double-booking guard.
 */
export const toReserva = (doc: ReservaDocument): Reserva => ({
  id: doc._id.toString(),
  espacio: nombreDeZona(doc.zonaId),
  residente: doc.residente,
  residenteId: doc.autorId?.toString(),
  inmueble: doc.unidad,
  fecha: toIso(doc.inicio) ?? '',
  horario: formatearRangoUtc(doc.inicio, doc.fin),
  estado: ESTADO_VISIBLE[doc.estado] ?? 'pendiente_aprobacion',
  motivo: doc.motivo ?? undefined,
});

/** Maps a Reserva document to a row of the approval queue. */
export const toReservaSolicitud = (doc: ReservaDocument): ReservaSolicitud => ({
  id: doc._id.toString(),
  residente: {
    nombre: doc.residente,
    unidad: doc.unidad,
    iniciales: iniciales(doc.residente),
  },
  area: nombreDeZona(doc.zonaId),
  fecha: toIso(doc.inicio) ?? '',
  horario: formatearRangoUtc(doc.inicio, doc.fin),
  estado: ESTADO_SOLICITUD[doc.estado] ?? 'pendiente',
  notas: doc.motivo ?? null,
});
