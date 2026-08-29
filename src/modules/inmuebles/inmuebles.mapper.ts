// src/modules/inmuebles/inmuebles.mapper.ts
import { Types } from 'mongoose';
import type {
  Inmueble as InmuebleContract,
  TitularResumen,
} from '../../contracts';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';

/** The shape `holderId` arrives in when the query populated it. */
type TitularPoblado = Pick<TerceroDocument, 'name' | 'identificationNumber'> & {
  _id: Types.ObjectId;
};

/**
 * Reads the holder off a `holderId` that may or may not have been populated.
 *
 * Returns null rather than a half-filled object when it was not: a listing that
 * quietly shows every unit as unowned because somebody forgot `.populate()` is
 * worse than one that shows nothing, because it looks plausible.
 */
const titularDe = (holderId: unknown): TitularResumen | null => {
  if (!holderId || holderId instanceof Types.ObjectId) return null;
  if (typeof holderId !== 'object' || !('name' in holderId)) return null;

  const tercero = holderId as TitularPoblado;
  return {
    id: tercero._id.toString(),
    nombre: tercero.name,
    identificacion: tercero.identificationNumber ?? null,
  };
};

/**
 * Maps a unit document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in AGENTS.md.
 */
export const toInmueble = (doc: InmuebleDocument): InmuebleContract => ({
  id: doc._id.toString(),
  codigo: doc.code,
  bloque: doc.block,
  zona: doc.zone,
  uso: doc.usage,
  area: doc.area,
  coeficiente: doc.participationFactor,
  titular: titularDe(doc.holderId),
  tipoTitular: doc.holderKind,
  resideEnElInmueble: doc.holderResides,
  estadoCartera: doc.collectionStatus,
  // The schema stores active/inactive; the contract says activo/inactivo. The
  // translation belongs here, not in a client that would have to learn English
  // to read a Spanish payload.
  estado: doc.status === 'active' ? 'activo' : 'inactivo',
});
