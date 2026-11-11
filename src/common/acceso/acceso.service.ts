// src/common/acceso/acceso.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Asignacion,
  AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  EntidadAdministradora,
  EntidadAdministradoraDocument,
} from '../../database/schemas/entidades/entidad-administradora.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Rol,
  RolDocument,
} from '../../database/schemas/administracion/rol.schema';
import { modulosEfectivos, type ModuloProducto } from '../licencia/modulos';
import {
  moduloDePermiso,
  type PerfilAsignacion,
} from '../../modules/casl/permisos-catalogo';

/**
 * Only KNOWN keys (`moduloDePermiso !== null`, Finanzas and Administración)
 * are returned, whatever their `perfil`: the profile never cuts permissions.
 * An unknown stored key grants nothing (`rulesFromPermissionKeys` skips it), so
 * listing it would only show the frontend a dead key: the clearest case is a
 * Finanzas `x.gestionar` saved before that verb was retired.
 *
 * A key of a module the coproperty did not contract stays in the list: it is
 * inert (every route carries its `@Modulo`), and contracting the module later
 * activates it with no data change.
 */
const clavesConocidas = (claves: readonly string[]): string[] =>
  claves.filter((clave) => moduloDePermiso(clave) !== null);

/** One coproperty a caller may operate, with the permissions that apply there. */
export interface AccesoCopropiedad {
  copropiedadId: string;
  codigo: string;
  nombre: string;
  permissions: string[];
  /** Product modules this coproperty has contracted (see `modulosEfectivos`). */
  modulos: ModuloProducto[];
  /**
   * Whether this account currently holds an active unit here as owner or
   * tenant (through its linked Tercero). A resident-only account carries no permissions: it reaches the
   * portal routes, never the administrative ones.
   */
  esResidente: boolean;
  /**
   * Profile the caller holds IN THIS coproperty, for the header label only (not
   * an access decision). `administrativo` wins when more than one route reaches
   * the building. `null` when no assignment reaches it (a resident-only account,
   * or a platform administrator, who carries no assignment).
   */
  perfil?: PerfilAsignacion | null;
  /**
   * Name of the Administración role the caller's DIRECT grant on this building
   * names (the first one, in the grant's own order), for the header label. Null
   * without one; never a role of another building (checked like the key merge).
   */
  rolNombre?: string | null;
}

@Injectable()
export class AccesoService {
  constructor(
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(EntidadAdministradora.name)
    private readonly entidades: Model<EntidadAdministradoraDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Rol.name)
    private readonly roles: Model<RolDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
  ) {}

  /**
   * Known keys (Finanzas and Administración) and the display name contributed
   * by the roles of each direct grant, keyed by coproperty id. Three filters
   * keep a role from ever widening access beyond its purpose: only roles the
   * grant names, only roles of the grant's own coproperty (the query returns by
   * id, so this is checked here, not trusted), and only known keys — an unknown
   * key inside a role is dropped, whatever got it there. One query for all
   * grants, none when no grant names a role.
   */
  private async permisosDeRoles(
    directas: Array<{
      copropiedadId: Types.ObjectId | null;
      roleIds?: Types.ObjectId[];
    }>,
  ): Promise<Map<string, { claves: string[]; nombre: string | null }>> {
    const aportes = new Map<
      string,
      { claves: string[]; nombre: string | null }
    >();
    const ids = directas.flatMap((a) => a.roleIds ?? []);
    if (ids.length === 0) return aportes;

    const encontrados = await this.roles
      .find({ _id: { $in: ids } })
      .select('copropiedadId permisos nombre')
      .lean()
      .exec();
    const porId = new Map(encontrados.map((r) => [r._id.toString(), r]));

    for (const a of directas) {
      if (!a.copropiedadId) continue;
      const propia = a.copropiedadId.toString();
      const claves = new Set<string>();
      let nombre: string | null = null;
      for (const id of a.roleIds ?? []) {
        const rol = porId.get(id.toString());
        if (!rol || rol.copropiedadId.toString() !== propia) continue;
        // The label shows one role: the first valid one the grant names.
        nombre ??= rol.nombre?.trim() || null;
        for (const clave of rol.permisos ?? []) {
          if (moduloDePermiso(clave) !== null) claves.add(clave);
        }
      }
      aportes.set(propia, { claves: [...claves], nombre });
    }
    return aportes;
  }

  /**
   * Ids of the coproperties where this account CURRENTLY holds a unit: linked to
   * an active Tercero that is the `titularId` or `arrendatarioId` of an active
   * unit of that same coproperty. Being linked is not enough: after a sale or
   * the end of a lease the Tercero stays linked, and the former holder must lose
   * the portal with it. One extra query, only when the account is linked.
   */
  private async copropiedadesComoResidente(
    accountId: string,
  ): Promise<Set<string>> {
    const vinculados = await this.terceros
      .find({ accountId: new Types.ObjectId(accountId), estado: 'active' })
      .select('_id copropiedadId')
      .lean()
      .exec();
    if (vinculados.length === 0) return new Set();

    const copropiedadDe = new Map(
      vinculados.map((t) => [t._id.toString(), t.copropiedadId.toString()]),
    );
    const ids = vinculados.map((t) => t._id);
    const unidades = await this.inmuebles
      .find({
        estado: 'active',
        $or: [{ titularId: { $in: ids } }, { arrendatarioId: { $in: ids } }],
      })
      .select('copropiedadId titularId arrendatarioId')
      .lean()
      .exec();

    const resultado = new Set<string>();
    for (const u of unidades) {
      const copropiedad = u.copropiedadId.toString();
      for (const parte of [u.titularId, u.arrendatarioId]) {
        // The party must belong to the unit's own coproperty: a unit pointing
        // at a foreign Tercero grants nothing anywhere.
        if (parte && copropiedadDe.get(parte.toString()) === copropiedad) {
          resultado.add(copropiedad);
        }
      }
    }
    return resultado;
  }

  /**
   * Every coproperty this account may operate, with effective permissions.
   *
   * Access arrives by two routes at once — a grant on one building, and a grant
   * on a managing company that covers all of its buildings — so this is a union,
   * not a lookup. Where both routes reach the same building the permissions are
   * merged, because a person given extra rights on one property should not lose
   * them by also belonging to the company that runs it.
   *
   * Inactive is filtered at every hop: a suspended assignment, a suspended
   * company, and a deactivated building each remove access on their own.
   */
  async copropiedadesDe(
    accountId: string,
    isPlatformAdmin = false,
  ): Promise<AccesoCopropiedad[]> {
    if (isPlatformAdmin) return this.todasLasCopropiedades();

    const asignaciones = await this.asignaciones
      .find({ accountId: new Types.ObjectId(accountId), estado: 'active' })
      .lean()
      .exec();

    // Coproperties where this account is a unit holder (owner or tenant) are
    // reachable too, with NO permissions: residents never pass CASL, they use
    // the portal routes.
    const residente = await this.copropiedadesComoResidente(accountId);
    if (asignaciones.length === 0 && residente.size === 0) return [];

    // Permissions keyed by coproperty, accumulated across both routes.
    const permisosPorCopropiedad = new Map<string, Set<string>>();

    const acumular = (id: string, permisos: string[]): void => {
      const actuales = permisosPorCopropiedad.get(id) ?? new Set<string>();
      for (const p of permisos) actuales.add(p);
      permisosPorCopropiedad.set(id, actuales);
    };

    // Header label data, per coproperty: the profile (administrativo wins when
    // two routes reach the same building) and the role name of a direct grant.
    const perfilPorCopropiedad = new Map<string, PerfilAsignacion>();
    const rolNombrePorCopropiedad = new Map<string, string>();
    const anotarPerfil = (id: string, perfil: PerfilAsignacion): void => {
      if (perfilPorCopropiedad.get(id) !== 'administrativo') {
        perfilPorCopropiedad.set(id, perfil);
      }
    };

    const directas = asignaciones.filter((a) => a.alcance === 'copropiedad');
    const deRoles = await this.permisosDeRoles(directas);
    for (const a of directas) {
      if (!a.copropiedadId) continue;
      const id = a.copropiedadId.toString();
      const delRol = deRoles.get(id);
      // Direct keys plus those of the roles the grant names (already known
      // keys): the union is what the member holds here, whatever the profile.
      acumular(id, [...clavesConocidas(a.permisos), ...(delRol?.claves ?? [])]);
      anotarPerfil(id, a.perfil ?? 'administrativo');
      if (delRol?.nombre) rolNombrePorCopropiedad.set(id, delRol.nombre);
    }

    const porEntidad = asignaciones.filter((a) => a.alcance === 'entidad');
    if (porEntidad.length > 0) {
      const entidadIds = porEntidad
        .map((a) => a.entidadId)
        .filter((id): id is Types.ObjectId => id != null);

      // A suspended company suspends the access its grants provide, without
      // touching the buildings themselves.
      const activas = await this.entidades
        .find({ _id: { $in: entidadIds }, estado: 'active' })
        .select('_id')
        .lean()
        .exec();
      const activasIds = new Set(activas.map((e) => e._id.toString()));

      const deEntidadesActivas = porEntidad.filter(
        (a) => a.entidadId && activasIds.has(a.entidadId.toString()),
      );

      if (deEntidadesActivas.length > 0) {
        const entidadObjectIds = deEntidadesActivas
          .map((a) => a.entidadId)
          .filter((id): id is Types.ObjectId => id != null)
          .map((id) => new Types.ObjectId(String(id)));

        const administradas = await this.copropiedades
          .find({
            entidadId: { $in: entidadObjectIds },
            estado: 'active',
          })
          .select('_id entidadId')
          .lean()
          .exec();

        // A company grant reaches every building it administers, so the
        // permissions of that grant land on each of them.
        const permisosPorEntidad = new Map<string, string[]>();
        const perfilPorEntidad = new Map<string, PerfilAsignacion>();
        for (const a of deEntidadesActivas) {
          permisosPorEntidad.set(
            a.entidadId!.toString(),
            clavesConocidas(a.permisos),
          );
          perfilPorEntidad.set(
            a.entidadId!.toString(),
            a.perfil ?? 'administrativo',
          );
        }

        for (const c of administradas) {
          const entidad = c.entidadId?.toString() ?? '';
          acumular(c._id.toString(), permisosPorEntidad.get(entidad) ?? []);
          anotarPerfil(
            c._id.toString(),
            perfilPorEntidad.get(entidad) ?? 'administrativo',
          );
        }
      }
    }

    for (const id of residente) {
      if (!permisosPorCopropiedad.has(id))
        permisosPorCopropiedad.set(id, new Set());
    }

    return this.describir(
      [...permisosPorCopropiedad.keys()],
      (id) => [...(permisosPorCopropiedad.get(id) ?? [])],
      residente,
      (id) => {
        const perfil = perfilPorCopropiedad.get(id) ?? null;
        // A role name only labels a `personal` profile; an administrativo
        // route reaching the same building outranks it.
        return {
          perfil,
          rolNombre:
            perfil === 'personal'
              ? (rolNombrePorCopropiedad.get(id) ?? null)
              : null,
        };
      },
    );
  }

  /**
   * The access this account has to one coproperty, or null if it has none.
   *
   * Called on every request that carries `X-CoProperty-Id`. It re-derives
   * access rather than trusting anything the client sent or the browser
   * remembered — an assignment revoked a minute ago has to stop working now.
   */
  async accesoA(
    accountId: string,
    copropiedadId: string,
    isPlatformAdmin = false,
  ): Promise<AccesoCopropiedad | null> {
    if (!Types.ObjectId.isValid(copropiedadId)) return null;

    const permitidas = await this.copropiedadesDe(accountId, isPlatformAdmin);
    return permitidas.find((c) => c.copropiedadId === copropiedadId) ?? null;
  }

  /** Platform operators see every active building, with no assignment needed. */
  private async todasLasCopropiedades(): Promise<AccesoCopropiedad[]> {
    const todas = await this.copropiedades
      .find({ estado: 'active' })
      .select('_id codigo nombre modulosContratados')
      .sort({ nombre: 1 })
      .lean()
      .exec();

    return todas.map((c) => ({
      copropiedadId: c._id.toString(),
      codigo: c.codigo,
      nombre: c.nombre,
      modulos: modulosEfectivos(c),
      // Left empty deliberately: a platform admin is granted everything by the
      // ability factory, not by carrying a copy of every permission key.
      permissions: [],
      esResidente: false,
      perfil: null,
      rolNombre: null,
    }));
  }

  /**
   * The scope of this account's primary assignment, for display purposes
   * (the header's "who is signed in" label) — not an access decision, so it
   * skips permissions and names entirely. Null means no active assignment.
   */
  async alcancePrimarioDe(
    accountId: string,
  ): Promise<'copropiedad' | 'entidad' | null> {
    const asignacion = await this.asignaciones
      .findOne({ accountId: new Types.ObjectId(accountId), estado: 'active' })
      .select('alcance')
      .lean()
      .exec();
    return asignacion?.alcance ?? null;
  }

  /** Loads names for the resolved ids, dropping any that is not active. */
  private async describir(
    ids: string[],
    permisosDe: (id: string) => string[],
    residente: Set<string>,
    etiquetaDe: (id: string) => {
      perfil: PerfilAsignacion | null;
      rolNombre: string | null;
    } = () => ({ perfil: null, rolNombre: null }),
  ): Promise<AccesoCopropiedad[]> {
    if (ids.length === 0) return [];

    const encontradas = await this.copropiedades
      .find({
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        estado: 'active',
      })
      .select('_id codigo nombre modulosContratados')
      .sort({ nombre: 1 })
      .lean()
      .exec();

    return encontradas.map((c) => ({
      copropiedadId: c._id.toString(),
      codigo: c.codigo,
      nombre: c.nombre,
      modulos: modulosEfectivos(c),
      permissions: permisosDe(c._id.toString()),
      esResidente: residente.has(c._id.toString()),
      ...etiquetaDe(c._id.toString()),
    }));
  }
}
