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
  Rol,
  RolDocument,
} from '../../database/schemas/administracion/rol.schema';
import { modulosEfectivos, type ModuloProducto } from '../licencia/modulos';
import {
  moduloDePermiso,
  sinPermisosVetados,
  type PerfilAsignacion,
} from '../../modules/casl/permisos-catalogo';

/**
 * Permissions an assignment really grants: the hard ceiling is applied on
 * read too, so a row written before the ceiling existed (or edited straight in
 * the database) can never hand Finanzas to operational staff.
 */
const permisosEfectivosDe = (a: {
  perfil?: PerfilAsignacion;
  permisos: string[];
}): string[] => sinPermisosVetados(a.perfil ?? 'administrativo', a.permisos);

/** One coproperty a caller may operate, with the permissions that apply there. */
export interface AccesoCopropiedad {
  copropiedadId: string;
  codigo: string;
  nombre: string;
  permissions: string[];
  /** Product modules this coproperty has contracted (see `modulosEfectivos`). */
  modulos: ModuloProducto[];
  /**
   * Whether this account holds a unit here as owner or tenant (it is linked to
   * a Tercero). A resident-only account carries no permissions: it reaches the
   * portal routes, never the administrative ones.
   */
  esResidente: boolean;
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
  ) {}

  /**
   * Administración keys contributed by the roles of each direct grant, keyed by
   * coproperty id. Three filters keep a role from ever widening access beyond
   * its purpose: only roles the grant names, only roles of the grant's own
   * coproperty (the query returns by id, so this is checked here, not trusted),
   * and only Administración keys — a Finanzas or unknown key inside a role is
   * dropped, whatever got it there. One query for all grants, none when no grant
   * names a role.
   */
  private async permisosDeRoles(
    directas: Array<{
      copropiedadId: Types.ObjectId | null;
      roleIds?: Types.ObjectId[];
    }>,
  ): Promise<Map<string, string[]>> {
    const aportes = new Map<string, string[]>();
    const ids = directas.flatMap((a) => a.roleIds ?? []);
    if (ids.length === 0) return aportes;

    const encontrados = await this.roles
      .find({ _id: { $in: ids } })
      .select('copropiedadId permisos')
      .lean()
      .exec();
    const porId = new Map(encontrados.map((r) => [r._id.toString(), r]));

    for (const a of directas) {
      if (!a.copropiedadId) continue;
      const propia = a.copropiedadId.toString();
      const claves = new Set<string>();
      for (const id of a.roleIds ?? []) {
        const rol = porId.get(id.toString());
        if (!rol || rol.copropiedadId.toString() !== propia) continue;
        for (const clave of rol.permisos ?? []) {
          if (moduloDePermiso(clave) === 'administracion') claves.add(clave);
        }
      }
      aportes.set(propia, [...claves]);
    }
    return aportes;
  }

  /** Ids of the coproperties where this account is linked to an active Tercero. */
  private async copropiedadesComoResidente(
    accountId: string,
  ): Promise<Set<string>> {
    const vinculados = await this.terceros
      .find({ accountId: new Types.ObjectId(accountId), estado: 'active' })
      .select('copropiedadId')
      .lean()
      .exec();
    return new Set(vinculados.map((t) => t.copropiedadId.toString()));
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

    const directas = asignaciones.filter((a) => a.alcance === 'copropiedad');
    const deRoles = await this.permisosDeRoles(directas);
    for (const a of directas) {
      if (!a.copropiedadId) continue;
      const id = a.copropiedadId.toString();
      // The ceiling applies to the union, so a role can never lift it either.
      acumular(
        id,
        permisosEfectivosDe({
          perfil: a.perfil,
          permisos: [...a.permisos, ...(deRoles.get(id) ?? [])],
        }),
      );
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
        for (const a of deEntidadesActivas) {
          permisosPorEntidad.set(
            a.entidadId!.toString(),
            permisosEfectivosDe(a),
          );
        }

        for (const c of administradas) {
          const permisos =
            permisosPorEntidad.get(c.entidadId?.toString() ?? '') ?? [];
          acumular(c._id.toString(), permisos);
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
    }));
  }
}
