// src/modules/copropiedades/copropiedades.mapper.ts
import { Types } from 'mongoose';
import type { Copropiedad as CopropiedadContract } from '../../contracts';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/** The shape `managingEntityId` arrives in when the query populated it. */
type EntidadPoblada = { _id: Types.ObjectId; name: string };

/**
 * Reads the managing entity off a `managingEntityId` that may or may not have
 * been populated. Returns null rather than a half-filled object when it was
 * not — the same defensive shape as toInmueble's titularDe.
 */
const entidadDe = (
  managingEntityId: unknown,
): { id: string; nombre: string } | null => {
  if (!managingEntityId || managingEntityId instanceof Types.ObjectId) {
    return null;
  }
  if (typeof managingEntityId !== 'object' || !('name' in managingEntityId)) {
    return null;
  }
  const entidad = managingEntityId as EntidadPoblada;
  return { id: entidad._id.toString(), nombre: entidad.name };
};

/**
 * Maps a coproperty document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in AGENTS.md.
 */
export const toCopropiedad = (
  doc: CopropiedadDocument,
): CopropiedadContract => ({
  id: doc._id.toString(),
  codigo: doc.code,
  nombre: doc.name,
  nit: doc.taxId,
  digitoVerificacion: doc.taxIdVerificationDigit,
  direccion: doc.address,
  ciudad: doc.city,
  telefono: doc.phone,
  email: doc.email,
  entidadAdministradora: entidadDe(doc.managingEntityId),
  nombreAdministrador: doc.administratorName,
  estado: doc.status === 'active' ? 'activo' : 'inactivo',
  usaGestionEdificios: doc.usesBuildingManagement,
  cuentaContableCartera: doc.receivablesAccount,
  cuentaAnticipos: doc.advancesAccount,
  cuentaDevoluciones: doc.creditNotesAccount,
  cuentaNotasDebito: doc.debitNotesAccount,
});
