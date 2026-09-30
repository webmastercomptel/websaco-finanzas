// src/modules/inmuebles/inmuebles.mapper.ts
import { Types } from 'mongoose';
import type {
  Inmueble as InmuebleContract,
  TitularResumen,
} from '../../contracts';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';

/** The shape `titularId` arrives in when the query populated it. */
type TitularPoblado = Pick<
  TerceroDocument,
  'nombre' | 'numeroIdentificacion'
> & {
  _id: Types.ObjectId;
};

/**
 * Reads the holder off a `titularId` that may or may not have been populated.
 *
 * Returns null rather than a half-filled object when it was not: a listing that
 * quietly shows every unit as unowned because somebody forgot `.populate()` is
 * worse than one that shows nothing, because it looks plausible.
 */
const titularDe = (titularId: unknown): TitularResumen | null => {
  if (!titularId || titularId instanceof Types.ObjectId) return null;
  if (typeof titularId !== 'object' || !('nombre' in titularId)) return null;

  const tercero = titularId as TitularPoblado;
  return {
    id: tercero._id.toString(),
    nombre: tercero.nombre,
    identificacion: tercero.numeroIdentificacion ?? null,
  };
};

/**
 * Maps a unit document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md.
 */
export const toInmueble = (doc: InmuebleDocument): InmuebleContract => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  referencia: doc.referencia,
  bloque: doc.bloque,
  zona: doc.zona,
  uso: doc.uso,
  area: doc.area,
  coeficiente: doc.coeficiente,
  titular: titularDe(doc.titularId),
  tipoTitular: doc.tipoTitular,
  resideEnElInmueble: doc.resideEnElInmueble,
  estadoCartera: doc.estadoCartera,
  estado: doc.estado === 'active' ? 'activo' : 'inactivo',
  observaciones: doc.observaciones,
  fechaActualizacion: doc.updatedAt.toISOString(),
});
