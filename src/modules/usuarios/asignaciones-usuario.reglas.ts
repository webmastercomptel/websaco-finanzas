// src/modules/usuarios/asignaciones-usuario.reglas.ts
//
// The two owner decisions of the platform Usuarios screen that may flip later,
// each isolated in ONE pure function. Mirrored in the frontend
// (`lib/usuarios/asignaciones.ts`): change both sides together.
import type { Types } from 'mongoose';
import type { PerfilAsignacion } from '../casl/permisos-catalogo';

/** What the platform Usuarios screen may do to one assignment row. */
export interface AccionesSobreAcceso {
  /** Replace the row's `permisos`. */
  editarClaves: boolean;
  /** Set the row inactive. */
  desactivar: boolean;
  /** Set an inactive row active again (through PATCH `estado`). */
  reactivar: boolean;
}

/**
 * Assumption 1: a `personal` row (created by Equipo) is read-only in Usuarios,
 * and only `administrativo` rows are managed here. Flipping it ("the platform
 * may deactivate Equipo rows") is a change of this table plus its mirror.
 */
export function accionesDesdeUsuarios(
  perfil: PerfilAsignacion,
): AccionesSobreAcceso {
  const gestionable = perfil === 'administrativo';
  return {
    editarClaves: gestionable,
    desactivar: gestionable,
    reactivar: gestionable,
  };
}

/**
 * Assumption 3: a row reactivated from Usuarios becomes `administrativo` and
 * its roles are cleared, so it never silently regains the roles of an earlier
 * life. Flipping it ("keep the roles") is `return { ..., roleIds:
 * fila.roleIds ?? [] }`: the service computes the audit's "after" set from
 * whatever this returns, so `detalle` stays right with no other change. Side
 * effect to announce if flipped: roles held by an `administrativo` row lock the
 * role's key edits in `RolesService`.
 */
export function estadoAlReactivar(fila: { roleIds?: Types.ObjectId[] }): {
  perfil: 'administrativo';
  roleIds: Types.ObjectId[];
} {
  void fila;
  return { perfil: 'administrativo', roleIds: [] };
}
