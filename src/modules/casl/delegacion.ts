// src/modules/casl/delegacion.ts
//
// The delegation cap of Equipo and Roles: "you can only give, or take away,
// permissions you hold yourself". Pure functions with no Nest DI and no I/O —
// the callers load the before and after key sets and hand them over — so the
// whole rule is unit-testable without mocks, and the frontend mirrors it
// one-to-one.
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  esPermisoAdministracion,
  esPermisoFinanzas,
} from './permisos-catalogo';

/**
 * Who is delegating. `IRequestUser` fits structurally: `permissions` is the
 * caller's effective key set in the ACTIVE coproperty, and a platform admin
 * carries none by design (it holds `manage all` instead).
 */
export interface Delegante {
  isPlatformAdmin?: boolean;
  permissions?: readonly string[];
}

/**
 * What a write changed in a set of keys. Also the shape of the audit
 * `detalle`, so the entry records exactly the keys the cap judged.
 */
export interface CambioDeClaves {
  agregadas: string[];
  quitadas: string[];
}

/**
 * An offered key: the Finanzas catalog (`PERMISOS_FINANZAS`) plus the
 * Administración catalog — the keys a permission grid can draw. Equipo and
 * Roles accept only these as NEW keys, so a client cannot store a key no route
 * checks. A key that is grammar-valid but not offered (`inmuebles.aprobar`) or
 * unknown (a legacy Finanzas `facturas.gestionar`) grants nothing any route
 * checks, which is why the cap never judges it: judging it would only block
 * saving a row whose old keys travel back untouched.
 */
export function esClaveOfrecida(clave: string): boolean {
  return esPermisoFinanzas(clave) || esPermisoAdministracion(clave);
}

/**
 * Union of the lists, de-duplicated, keeping only offered keys: the set the cap
 * judges. A member's effective set is their direct keys plus the keys of their
 * roles, which is why this takes several lists.
 */
export function clavesEfectivas(
  ...listas: ReadonlyArray<readonly string[]>
): string[] {
  const vistas = new Set<string>();
  for (const lista of listas) {
    for (const clave of lista) {
      if (esClaveOfrecida(clave)) vistas.add(clave);
    }
  }
  return [...vistas];
}

/**
 * Symmetric difference of the offered keys before and after, each side sorted.
 * A key present on both sides never appears, wherever it came from: re-sending
 * a key the caller does not hold, unchanged, is not a grant. Sorted so audit
 * entries and error messages are stable.
 */
export function cambioDeClaves(
  antes: readonly string[],
  despues: readonly string[],
): CambioDeClaves {
  const antesEfectivas = new Set(clavesEfectivas(antes));
  const despuesEfectivas = new Set(clavesEfectivas(despues));
  return {
    agregadas: [...despuesEfectivas]
      .filter((c) => !antesEfectivas.has(c))
      .sort(),
    quitadas: [...antesEfectivas]
      .filter((c) => !despuesEfectivas.has(c))
      .sort(),
  };
}

/**
 * The changed keys the delegante does not hold, sorted; empty for a platform
 * admin. The match is the EXACT key: Administración `tareas.gestionar` never
 * stands in for `tareas.ver`, and Finanzas has no covering key at all. Stricter
 * than a shortcut, never wider, so nobody can mint a permission by collusion.
 */
export function clavesFueraDeAlcance(
  delegante: Delegante,
  cambio: CambioDeClaves,
): string[] {
  if (delegante.isPlatformAdmin) return [];
  const tiene = new Set(delegante.permissions ?? []);
  return [...cambio.agregadas, ...cambio.quitadas]
    .filter((clave) => !tiene.has(clave))
    .sort();
}

/**
 * 403 `${mensaje}: a, b` naming every changed key the delegante does not hold,
 * otherwise returns the change so the caller can audit it without recomputing.
 * Deactivating someone is `despues = []` with its own message: it only passes
 * when the caller holds everything the person had.
 */
export function exigirDelegacion(
  delegante: Delegante,
  antes: readonly string[],
  despues: readonly string[],
  mensaje = 'No puedes otorgar ni quitar permisos que no tienes',
): CambioDeClaves {
  const cambio = cambioDeClaves(antes, despues);
  const fuera = clavesFueraDeAlcance(delegante, cambio);
  if (fuera.length > 0) {
    throw new ForbiddenException(`${mensaje}: ${fuera.join(', ')}`);
  }
  return cambio;
}

/**
 * 400 `Permisos que no existen: …` for the keys in `despues` that are not in
 * `antes` and are not offered. Only the NEW keys are judged, so a legacy key
 * that is stored and travels back unchanged never blocks a save. It has no
 * actor on purpose: the platform admin is exempt from the cap, not from the
 * catalog.
 */
export function exigirClavesConocidas(
  despues: readonly string[],
  antes: readonly string[] = [],
): void {
  const previas = new Set(antes);
  const invalidas = [
    ...new Set(
      despues.filter((clave) => !previas.has(clave) && !esClaveOfrecida(clave)),
    ),
  ];
  if (invalidas.length > 0) {
    throw new BadRequestException(
      `Permisos que no existen: ${invalidas.join(', ')}`,
    );
  }
}
