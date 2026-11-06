// src/modules/casl/permisos-catalogo.ts
//
// Which product module owns each permission key, and the hard ceiling that
// keeps operational staff out of Finanzas. Pure functions over the same maps
// `permission-map.ts` uses to build abilities, so the two can never disagree
// about what a key means.
import type { ModuloProducto } from '../../common/licencia/modulos';
import {
  MODULE_TO_SUBJECT,
  MODULE_TO_SUBJECT_ADMINISTRACION,
  VERB_TO_ACTION,
  VERB_TO_ACTION_ADMINISTRACION,
} from './permission-map';

/** `administrativo` runs the coproperty; `personal` is operational staff. */
export const PERFILES_ASIGNACION = ['administrativo', 'personal'] as const;
export type PerfilAsignacion = (typeof PERFILES_ASIGNACION)[number];

/**
 * Module that owns each `modulo` segment of a permission key: the financial
 * segments belong to Finanzas, the building-management ones to Administración.
 */
const MODULO_DE_SEGMENTO: Record<string, ModuloProducto> = {
  ...Object.fromEntries(
    Object.keys(MODULE_TO_SUBJECT).map((segmento) => [segmento, 'finanzas']),
  ),
  ...Object.fromEntries(
    Object.keys(MODULE_TO_SUBJECT_ADMINISTRACION).map((segmento) => [
      segmento,
      'administracion',
    ]),
  ),
};

/**
 * The module that owns a `modulo.verbo` key, or null when the key is unknown.
 * Verbs are checked against the module's own vocabulary: `eliminar`, `subir`
 * and `actualizar` exist only for Administración keys.
 */
export function moduloDePermiso(clave: string): ModuloProducto | null {
  const partes = clave.split('.');
  if (partes.length !== 2) return null;
  const [segmento, verbo] = partes;
  const modulo = MODULO_DE_SEGMENTO[segmento];
  if (!modulo) return null;
  const verboValido =
    verbo in VERB_TO_ACTION ||
    (modulo === 'administracion' && verbo in VERB_TO_ACTION_ADMINISTRACION);
  return verboValido ? modulo : null;
}

/** Keys that are not in the catalog (typos, removed verbs, invented modules). */
export function permisosDesconocidos(claves: readonly string[]): string[] {
  return claves.filter((c) => moduloDePermiso(c) === null);
}

/**
 * Keys this profile may never hold. Operational staff never touch Finanzas,
 * whatever a role editor sends: this is the ceiling, enforced on write and
 * again on read.
 */
export function permisosVetadosParaPerfil(
  perfil: PerfilAsignacion,
  claves: readonly string[],
): string[] {
  if (perfil !== 'personal') return [];
  return claves.filter((c) => moduloDePermiso(c) === 'finanzas');
}

/** The keys that survive the ceiling for this profile (applied when reading). */
export function sinPermisosVetados(
  perfil: PerfilAsignacion,
  claves: readonly string[],
): string[] {
  const vetados = new Set(permisosVetadosParaPerfil(perfil, claves));
  return claves.filter((c) => !vetados.has(c));
}
