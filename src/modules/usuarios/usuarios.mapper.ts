// src/modules/usuarios/usuarios.mapper.ts
import { Types } from 'mongoose';
import type {
  Usuario as UsuarioContract,
  AsignacionResumen,
} from '../../contracts';
import type { AccountDocument } from '../../database/schemas/cuentas/account.schema';
import type { AsignacionDocument } from '../../database/schemas/cuentas/asignacion.schema';

/** Reads a populated reference's name off a field that may still be a raw id. */
const nombreDe = (ref: unknown): { id: string; nombre: string } | null => {
  if (!ref || ref instanceof Types.ObjectId) return null;
  if (typeof ref !== 'object' || !('name' in ref)) return null;
  const r = ref as { _id: Types.ObjectId; name: string };
  return { id: r._id.toString(), nombre: r.name };
};

/**
 * Maps one assignment to the Spanish contract. Persistence is English, the
 * API is Spanish — see "the contract law" in AGENTS.md.
 */
export const toAsignacionResumen = (
  doc: AsignacionDocument,
): AsignacionResumen => {
  const copropiedad =
    doc.scope === 'copropiedad' ? nombreDe(doc.coPropertyId) : null;
  const entidad = doc.scope === 'entidad' ? nombreDe(doc.entidadId) : null;

  return {
    alcance: doc.scope,
    copropiedadId: copropiedad?.id ?? null,
    copropiedadNombre: copropiedad?.nombre ?? null,
    entidadId: entidad?.id ?? null,
    entidadNombre: entidad?.nombre ?? null,
    permisos: doc.permissions,
  };
};

/**
 * Maps an account and its primary assignment (if any) to the Spanish contract.
 */
export const toUsuario = (
  cuenta: AccountDocument,
  asignacion: AsignacionDocument | null,
): UsuarioContract => ({
  id: cuenta._id.toString(),
  nombre: cuenta.fullName,
  email: cuenta.email,
  esAdministradorPlataforma: cuenta.isPlatformAdmin,
  estado: cuenta.status === 'active' ? 'activo' : 'inactivo',
  asignacion: asignacion ? toAsignacionResumen(asignacion) : null,
});
