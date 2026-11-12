// src/common/cuentas/politica-enlace.ts
import { moduloDePermiso } from '../../modules/casl/permisos-catalogo';

/**
 * The one rule that decides who may EVER get a session from an e-mailed link,
 * shared by both kinds of link (the account-bound access link of
 * `EnlaceAccesoService` and the sign-in link of the resident portal).
 *
 * A link opens a full session, not one pinned to the link's building, and a
 * forwarded e-mail must never be a way into the financial side. So it is
 * refused to:
 * - a platform administrator;
 * - an inactive account;
 * - anyone holding a Finanzas key in ANY coproperty they reach (`accesos`
 *   lists every coproperty, with the effective keys of each);
 * - anyone with an active assignment that is not `personal` (administrativo or
 *   company-wide) anywhere (`tieneNoPersonal`): such a row can receive Finanzas
 *   keys at any moment, so those people sign in with their password.
 *
 * Residents and team members with Administración keys only are the audience.
 * Pure on purpose: the callers fetch the facts, this decides.
 */
export function cuentaAdmiteSesionPorEnlace(entrada: {
  cuenta: { estado: string; esAdministradorPlataforma: boolean };
  accesos: ReadonlyArray<{ permissions: readonly string[] }>;
  tieneNoPersonal: boolean;
}): boolean {
  const { cuenta, accesos, tieneNoPersonal } = entrada;
  if (cuenta.estado !== 'active') return false;
  if (cuenta.esAdministradorPlataforma) return false;

  const tieneFinanzas = accesos.some((a) =>
    a.permissions.some((p) => moduloDePermiso(p) === 'finanzas'),
  );
  if (tieneFinanzas) return false;

  return !tieneNoPersonal;
}
