// src/modules/copropiedades/copropiedades.mapper.ts
import { Types } from 'mongoose';
import type { Copropiedad as CopropiedadContract } from '../../contracts';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/** The shape `entidadId` arrives in when the query populated it. */
type EntidadPoblada = { _id: Types.ObjectId; nombre: string };

/**
 * Reads the managing entity off a `entidadId` that may or may not have
 * been populated. Returns null rather than a half-filled object when it was
 * not — the same defensive shape as toInmueble's titularDe.
 */
const entidadDe = (
  entidadId: unknown,
): { id: string; nombre: string } | null => {
  if (!entidadId || entidadId instanceof Types.ObjectId) {
    return null;
  }
  if (typeof entidadId !== 'object' || !('nombre' in entidadId)) {
    return null;
  }
  const entidad = entidadId as EntidadPoblada;
  return { id: entidad._id.toString(), nombre: entidad.nombre };
};

/**
 * Maps a coproperty document to the Spanish API contract.
 *
 * Persistence and the API are both Spanish — see "the contract law" in
 * CLAUDE.md. This mapper's job is type conversion and composing the live
 * `usuarioAdministrador` lookup, never language translation.
 */
export const toCopropiedad = (
  doc: CopropiedadDocument,
  usuarioAdministrador: string | null = null,
): CopropiedadContract => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  nombre: doc.nombre,
  nit: doc.nit,
  digitoVerificacion: doc.digitoVerificacion,
  direccion: doc.direccion,
  ciudad: doc.ciudad,
  telefono: doc.telefono,
  email: doc.email,
  mostrarLogo: doc.mostrarLogo,
  entidadAdministradora: entidadDe(doc.entidadId),
  nombreAdministrador: doc.nombreAdministrador,
  usuarioAdministrador,
  estado: doc.estado === 'active' ? 'activo' : 'inactivo',
  usaGestionEdificios: doc.usaGestionEdificios,
  cuentaContableCartera: doc.cuentaContableCartera,
  cuentaAnticipos: doc.cuentaAnticipos,
  cuentaDevoluciones: doc.cuentaDevoluciones,
  cuentaNotasDebito: doc.cuentaNotasDebito,
});
