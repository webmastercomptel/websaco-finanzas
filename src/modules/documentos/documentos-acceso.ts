// src/modules/documentos/documentos-acceso.ts
//
// Pure folder-access resolution — NO database, NO Nest. Given a folder, the
// caller and a lookup of the coproperty's folders, it computes the effective
// access, so the authorization rules are unit-testable without Mongo.

/** Permission key that administers every folder, bypassing every rule. */
export const PERMISO_GESTIONAR_DOCUMENTOS =
  'documentos-administracion.gestionar';

/** Effective access over one folder. */
export interface AccesoCarpeta {
  puedeLeer: boolean;
  puedeEscribir: boolean;
  puedeAdministrar: boolean;
}

/** A staff caller reduced to what folder authorization needs. */
export interface ActorDocumentos {
  /** Roles granted to the caller by a direct assignment to THIS coproperty. */
  roleIds: ReadonlySet<string>;
  /** Holds `gestionar` (or is a platform admin): bypasses every rule. */
  gestiona: boolean;
}

/** How a resident holds units here; a person can be both (owner of one, tenant of another). */
export type TipoResidente = 'propietario' | 'arrendatario';

/** Structural view of a folder rule (matches the `AclCarpetaDocumento` subdocument). */
export interface EntradaAcl {
  tipo: 'rol' | 'residentes';
  rolId?: { toString(): string } | null;
  rol?: 'propietario' | 'arrendatario' | 'todos' | null;
  puedeLeer: boolean;
  puedeEscribir: boolean;
}

/** Structural view of a folder (matches a `CarpetaDocumentoDocument`). */
export interface NodoCarpeta {
  _id: { toString(): string };
  carpetaPadreId?: { toString(): string } | null;
  acls?: EntradaAcl[];
}

const SIN_ACCESO: AccesoCarpeta = {
  puedeLeer: false,
  puedeEscribir: false,
  puedeAdministrar: false,
};

const ACCESO_TOTAL: AccesoCarpeta = {
  puedeLeer: true,
  puedeEscribir: true,
  puedeAdministrar: true,
};

/**
 * The rules that govern a folder: its own if it defines any, otherwise those of
 * the nearest ancestor that does. Empty when nothing in the chain defines rules,
 * which means PRIVATE (see `accesoDelPersonal`), never public.
 */
export function aclsEfectivos(
  carpeta: NodoCarpeta,
  porId: ReadonlyMap<string, NodoCarpeta>,
): EntradaAcl[] {
  const visitadas = new Set<string>();
  let nodo: NodoCarpeta | undefined = carpeta;
  while (nodo && !visitadas.has(nodo._id.toString())) {
    visitadas.add(nodo._id.toString());
    if (nodo.acls && nodo.acls.length > 0) return nodo.acls;
    const padreId: string | null = nodo.carpetaPadreId
      ? nodo.carpetaPadreId.toString()
      : null;
    nodo = padreId ? porId.get(padreId) : undefined;
  }
  return [];
}

/**
 * The rules a folder INHERITS from its ancestors (ignoring its own) plus the id
 * of the ancestor that provides them. Used to show "inherited from X" and to
 * prefill the editor. Empty/null when no ancestor defines rules.
 */
export function aclsHeredados(
  carpeta: NodoCarpeta,
  porId: ReadonlyMap<string, NodoCarpeta>,
): { acls: EntradaAcl[]; origenId: string | null } {
  const visitadas = new Set<string>([carpeta._id.toString()]);
  let padreId = carpeta.carpetaPadreId
    ? carpeta.carpetaPadreId.toString()
    : null;
  let nodo = padreId ? porId.get(padreId) : undefined;
  while (nodo && !visitadas.has(nodo._id.toString())) {
    visitadas.add(nodo._id.toString());
    if (nodo.acls && nodo.acls.length > 0) {
      return { acls: nodo.acls, origenId: nodo._id.toString() };
    }
    padreId = nodo.carpetaPadreId ? nodo.carpetaPadreId.toString() : null;
    nodo = padreId ? porId.get(padreId) : undefined;
  }
  return { acls: [], origenId: null };
}

/**
 * Effective access of a STAFF caller over a folder.
 *
 * `gestiona` bypasses everything. Otherwise only `rol` rules count (residents'
 * rules are for the portal), cumulative across the caller's roles. Private by
 * default: a folder with no rules anywhere in its chain is NOT public, because
 * sensitive content (finance, legal) must never be readable just because nobody
 * configured it yet. `puedeAdministrar` is never granted by a rule.
 */
export function accesoDelPersonal(
  carpeta: NodoCarpeta,
  actor: ActorDocumentos,
  porId: ReadonlyMap<string, NodoCarpeta>,
): AccesoCarpeta {
  if (actor.gestiona) return { ...ACCESO_TOTAL };
  const mias = aclsEfectivos(carpeta, porId).filter(
    (a) =>
      a.tipo === 'rol' &&
      a.rolId != null &&
      actor.roleIds.has(a.rolId.toString()),
  );
  if (mias.length === 0) return { ...SIN_ACCESO };
  return {
    puedeLeer: mias.some((a) => a.puedeLeer),
    puedeEscribir: mias.some((a) => a.puedeEscribir),
    puedeAdministrar: false,
  };
}

/** Whether a rule list lets a resident holding units as `tipos` read. */
export function reglasDejanLeerAResidente(
  acls: readonly EntradaAcl[],
  tipos: ReadonlySet<TipoResidente>,
): boolean {
  if (tipos.size === 0) return false;
  return acls.some(
    (a) =>
      a.tipo === 'residentes' &&
      a.puedeLeer &&
      (a.rol === 'todos' || (a.rol != null && tipos.has(a.rol))),
  );
}

/**
 * Whether a RESIDENT may read a folder. Residents never write, and a folder with
 * no `residentes` rule in its effective chain is invisible to them.
 */
export function residentePuedeLeer(
  carpeta: NodoCarpeta,
  tipos: ReadonlySet<TipoResidente>,
  porId: ReadonlyMap<string, NodoCarpeta>,
): boolean {
  return reglasDejanLeerAResidente(aclsEfectivos(carpeta, porId), tipos);
}
