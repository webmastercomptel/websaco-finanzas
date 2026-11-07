// src/modules/casl/permisos-catalogo.ts
//
// Which product module owns each permission key, and the hard ceiling that
// keeps operational staff out of Finanzas. Pure functions over the same maps
// `permission-map.ts` uses to build abilities, so the two can never disagree
// about what a key means.
import type { ModuloProducto } from '../../common/licencia/modulos';
import { createAppAbility, type Subject } from './casl-ability.constants';
import {
  MODULE_TO_SUBJECT,
  MODULE_TO_SUBJECT_ADMINISTRACION,
  rulesFromPermissionKeys,
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

/** One assignable Administración permission, as the role editor lists it. */
export interface PermisoCatalogo {
  /** The `modulo.accion` key stored on roles and assignments. */
  id: string;
  nombre: string;
  descripcion: string;
  /** Group heading in the editor. */
  modulo: string;
}

const permiso = (
  id: string,
  nombre: string,
  descripcion: string,
  modulo: string,
): PermisoCatalogo => ({ id, nombre, descripcion, modulo });

/**
 * The Administración permissions a role can bundle: the catalog the building-
 * management system seeded, with one deliberate change — its `documentos.*` keys
 * are `documentos-administracion.*` here, because `documentos` is a Finanzas
 * segment (see `MODULE_TO_SUBJECT`). The migration translates stored keys.
 *
 * Code, not a collection: the vocabulary has to match `permission-map.ts`
 * exactly, and a seeded copy could drift from it.
 */
export const PERMISOS_ADMINISTRACION: readonly PermisoCatalogo[] = [
  permiso(
    'dashboard.ver',
    'Ver Dashboard',
    'Acceso al panel principal',
    'Dashboard',
  ),
  permiso('anuncios.ver', 'Ver Anuncios', 'Ver lista de anuncios', 'Anuncios'),
  permiso(
    'anuncios.crear',
    'Crear Anuncios',
    'Publicar nuevos anuncios',
    'Anuncios',
  ),
  permiso(
    'anuncios.editar',
    'Editar Anuncios',
    'Modificar anuncios existentes',
    'Anuncios',
  ),
  permiso(
    'anuncios.eliminar',
    'Eliminar Anuncios',
    'Borrar anuncios',
    'Anuncios',
  ),
  permiso(
    'usuarios.ver',
    'Ver Usuarios',
    'Ver directorio de usuarios',
    'Usuarios',
  ),
  permiso(
    'usuarios.crear',
    'Crear Usuarios',
    'Registrar nuevos usuarios',
    'Usuarios',
  ),
  permiso(
    'usuarios.editar',
    'Editar Usuarios',
    'Modificar datos de usuarios',
    'Usuarios',
  ),
  permiso(
    'usuarios.eliminar',
    'Eliminar Usuarios',
    'Dar de baja usuarios',
    'Usuarios',
  ),
  permiso('pqr.ver', 'Ver PQR', 'Ver lista de PQR', 'PQR'),
  permiso(
    'pqr.gestionar',
    'Gestionar PQR',
    'Responder y cambiar estado',
    'PQR',
  ),
  permiso(
    'reservas.ver',
    'Ver Reservas',
    'Ver calendario de reservas',
    'Reservas',
  ),
  permiso(
    'reservas.aprobar',
    'Aprobar Reservas',
    'Aprobar o rechazar solicitudes',
    'Reservas',
  ),
  permiso(
    'documentos-administracion.ver',
    'Ver Documentos',
    'Acceder a documentos',
    'Documentos',
  ),
  permiso(
    'documentos-administracion.subir',
    'Subir Documentos',
    'Cargar nuevos archivos',
    'Documentos',
  ),
  permiso(
    'documentos-administracion.gestionar',
    'Gestionar Documentos',
    'Administrar todas las carpetas y sus permisos, sin importar los ACL',
    'Documentos',
  ),
  permiso(
    'config.ver',
    'Ver Configuración',
    'Acceso a configuración',
    'Configuración',
  ),
  permiso(
    'config.editar',
    'Editar Configuración',
    'Modificar ajustes del sistema',
    'Configuración',
  ),
  permiso(
    'roles.gestionar',
    'Gestionar Roles',
    'Crear y modificar roles',
    'Configuración',
  ),
  permiso('tareas.ver', 'Ver Tareas', 'Ver el tablero de tareas', 'Tareas'),
  permiso(
    'tareas.actualizar',
    'Actualizar Tareas Asignadas',
    'Completar y agregar observaciones a las tareas propias',
    'Tareas',
  ),
  permiso(
    'tareas.gestionar',
    'Gestionar Tareas',
    'Crear, editar y eliminar tareas',
    'Tareas',
  ),
  permiso(
    'mantenimientos.ver',
    'Ver Mantenimientos',
    'Ver el calendario de mantenimientos',
    'Mantenimientos',
  ),
  permiso(
    'mantenimientos.gestionar',
    'Gestionar Mantenimientos',
    'Crear, editar y eliminar mantenimientos',
    'Mantenimientos',
  ),
  permiso(
    'actividades.ver',
    'Ver Actividades',
    'Ver la agenda de actividades',
    'Actividades',
  ),
  permiso(
    'actividades.gestionar',
    'Gestionar Actividades',
    'Crear, editar y eliminar actividades',
    'Actividades',
  ),
  permiso(
    'zonas.ver',
    'Ver Zonas Comunes',
    'Ver las zonas comunes',
    'Zonas Comunes',
  ),
  permiso(
    'zonas.gestionar',
    'Gestionar Zonas Comunes',
    'Crear, editar y eliminar zonas comunes',
    'Zonas Comunes',
  ),
  permiso(
    'tecnicos.gestionar',
    'Gestionar Técnicos',
    'Crear, editar y eliminar técnicos',
    'PQR',
  ),
];

const CLAVES_ADMINISTRACION: ReadonlySet<string> = new Set(
  PERMISOS_ADMINISTRACION.map((p) => p.id),
);

/** Whether `clave` is one of the permissions a role may bundle. */
export function esPermisoAdministracion(clave: string): boolean {
  return CLAVES_ADMINISTRACION.has(clave);
}

/**
 * Whether a set of permission keys grants `read` on `materia` (`manage` implies
 * it, as in CASL). Used to decide who is worth notifying: a link into a screen
 * the person cannot open is noise. Built on the same key -> rule translation as
 * real authorization, so the two never disagree.
 */
export function puedeLeerMateria(
  claves: readonly string[],
  materia: Subject,
): boolean {
  return createAppAbility(rulesFromPermissionKeys([...claves])).can(
    'read',
    materia,
  );
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
