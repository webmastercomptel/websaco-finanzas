// src/modules/usuarios/usuarios.mapper.ts
import { Types } from 'mongoose';
import type {
  Usuario as UsuarioContract,
  AsignacionUsuario,
} from '../../contracts';
import type { AccountDocument } from '../../database/schemas/cuentas/account.schema';
import type { AsignacionDocument } from '../../database/schemas/cuentas/asignacion.schema';

/** Reads a populated reference's name off a field that may still be a raw id. */
const nombreDe = (ref: unknown): { id: string; nombre: string } | null => {
  if (!ref || ref instanceof Types.ObjectId) return null;
  if (typeof ref !== 'object' || !('nombre' in ref)) return null;
  const r = ref as { _id: Types.ObjectId; nombre: string };
  return { id: r._id.toString(), nombre: r.nombre };
};

/**
 * The id and name of a row's target. Unlike `nombreDe`, it never loses the id:
 * a populated reference gives both, a raw ObjectId gives the id, and a
 * reference whose document no longer exists (Mongoose leaves the path `null`
 * after populating) still answers through `populated()`, which keeps the id the
 * query used. The screen needs the id of a deleted target to say WHICH one it
 * was.
 */
const destinoDe = (
  doc: AsignacionDocument,
  ruta: 'copropiedadId' | 'entidadId',
): { id: string | null; nombre: string | null } => {
  const ref: unknown = doc[ruta];
  const poblado = nombreDe(ref);
  if (poblado) return poblado;
  if (ref instanceof Types.ObjectId)
    return { id: ref.toString(), nombre: null };
  const original: unknown =
    typeof doc.populated === 'function' ? doc.populated(ruta) : undefined;
  return {
    id: original instanceof Types.ObjectId ? original.toString() : null,
    nombre: null,
  };
};

/**
 * Maps one row to its entry of `Usuario.asignaciones`: every row, active or
 * inactive, of any profile. `permisos` is what is stored (never filtered by the
 * catalog) and `cantidadRoles` counts the roles of a `copropiedad` row only,
 * because an `entidad` row ignores them on read.
 */
export const toAsignacionUsuario = (
  doc: AsignacionDocument,
): AsignacionUsuario => {
  const copropiedad =
    doc.alcance === 'copropiedad'
      ? destinoDe(doc, 'copropiedadId')
      : { id: null, nombre: null };
  const entidad =
    doc.alcance === 'entidad'
      ? destinoDe(doc, 'entidadId')
      : { id: null, nombre: null };

  return {
    id: doc._id.toString(),
    alcance: doc.alcance,
    copropiedadId: copropiedad.id,
    copropiedadNombre: copropiedad.nombre,
    entidadId: entidad.id,
    entidadNombre: entidad.nombre,
    perfil: doc.perfil ?? 'administrativo',
    permisos: doc.permisos,
    estado: doc.estado === 'active' ? 'activo' : 'inactivo',
    cantidadRoles:
      doc.alcance === 'copropiedad' ? (doc.roleIds?.length ?? 0) : 0,
  };
};

/**
 * Maps an account and ALL its rows to the Spanish contract. `filas` arrive
 * oldest first, and that order is kept in `asignaciones`, the only
 * representation of them (there is no "primary" row).
 */
export const toUsuario = (
  cuenta: AccountDocument,
  filas: readonly AsignacionDocument[],
): UsuarioContract => {
  return {
    id: cuenta._id.toString(),
    nombre: cuenta.nombreCompleto,
    email: cuenta.email,
    esAdministradorPlataforma: cuenta.esAdministradorPlataforma,
    estado: cuenta.estado === 'active' ? 'activo' : 'inactivo',
    asignaciones: filas.map(toAsignacionUsuario),
  };
};
