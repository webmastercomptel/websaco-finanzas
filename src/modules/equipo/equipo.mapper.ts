// src/modules/equipo/equipo.mapper.ts
import type { MiembroEquipo, RolDeMiembro } from '../../contracts';

/** The slice of an assignment this module maps (always `.lean()`). */
export interface AsignacionEquipo {
  _id: { toString(): string };
  perfil?: 'administrativo' | 'personal';
  estado: 'active' | 'inactive';
  permisos: string[];
  roleIds?: Array<{ toString(): string }>;
}

/** The slice of an account this module maps. */
export interface CuentaEquipo {
  nombreCompleto: string;
  email: string;
  esAdministradorPlataforma: boolean;
  estado: 'active' | 'inactive';
}

/**
 * Maps one staff assignment to the contract. `id` is the ASSIGNMENT id (it
 * belongs to one coproperty), the account id never leaves. A legacy row without
 * `perfil` reads as `administrativo`, as `AccesoService` does, so it is shown as
 * not editable rather than as something this module may touch.
 *
 * Role names are resolved by the caller from ONE query for the whole list; a
 * role that no longer resolves (deleted) is simply omitted.
 */
export const toMiembroEquipo = (
  asignacion: AsignacionEquipo,
  cuenta: CuentaEquipo,
  rolesPorId: ReadonlyMap<string, RolDeMiembro>,
): MiembroEquipo => {
  const perfil = asignacion.perfil ?? 'administrativo';
  return {
    id: asignacion._id.toString(),
    nombre: cuenta.nombreCompleto,
    email: cuenta.email,
    perfil,
    estado:
      asignacion.estado === 'active' && cuenta.estado === 'active'
        ? 'activo'
        : 'inactivo',
    roles: (asignacion.roleIds ?? [])
      .map((id) => rolesPorId.get(id.toString()))
      .filter((r): r is RolDeMiembro => r !== undefined),
    permisos: asignacion.permisos,
    esAdministradorPlataforma: cuenta.esAdministradorPlataforma,
    editable: perfil === 'personal' && !cuenta.esAdministradorPlataforma,
  };
};
