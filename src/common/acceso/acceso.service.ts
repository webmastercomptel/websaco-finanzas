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

/** One coproperty a caller may operate, with the permissions that apply there. */
export interface AccesoCopropiedad {
  coPropertyId: string;
  codigo: string;
  nombre: string;
  permissions: string[];
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
  ) {}

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
      .find({ accountId: new Types.ObjectId(accountId), status: 'active' })
      .lean()
      .exec();

    if (asignaciones.length === 0) return [];

    // Permissions keyed by coproperty, accumulated across both routes.
    const permisosPorCopropiedad = new Map<string, Set<string>>();

    const acumular = (id: string, permisos: string[]): void => {
      const actuales = permisosPorCopropiedad.get(id) ?? new Set<string>();
      for (const p of permisos) actuales.add(p);
      permisosPorCopropiedad.set(id, actuales);
    };

    const directas = asignaciones.filter((a) => a.scope === 'copropiedad');
    for (const a of directas) {
      if (a.coPropertyId) acumular(a.coPropertyId.toString(), a.permissions);
    }

    const porEntidad = asignaciones.filter((a) => a.scope === 'entidad');
    if (porEntidad.length > 0) {
      const entidadIds = porEntidad
        .map((a) => a.entidadId)
        .filter((id): id is Types.ObjectId => id != null);

      // A suspended company suspends the access its grants provide, without
      // touching the buildings themselves.
      const activas = await this.entidades
        .find({ _id: { $in: entidadIds }, status: 'active' })
        .select('_id')
        .lean()
        .exec();
      const activasIds = new Set(activas.map((e) => e._id.toString()));

      const deEntidadesActivas = porEntidad.filter(
        (a) => a.entidadId && activasIds.has(a.entidadId.toString()),
      );

      if (deEntidadesActivas.length > 0) {
        const administradas = await this.copropiedades
          .find({
            managingEntityId: {
              $in: deEntidadesActivas.map((a) => a.entidadId),
            },
            status: 'active',
          })
          .select('_id managingEntityId')
          .lean()
          .exec();

        // A company grant reaches every building it administers, so the
        // permissions of that grant land on each of them.
        const permisosPorEntidad = new Map<string, string[]>();
        for (const a of deEntidadesActivas) {
          permisosPorEntidad.set(a.entidadId!.toString(), a.permissions);
        }

        for (const c of administradas) {
          const permisos =
            permisosPorEntidad.get(c.managingEntityId?.toString() ?? '') ?? [];
          acumular(c._id.toString(), permisos);
        }
      }
    }

    return this.describir([...permisosPorCopropiedad.keys()], (id) => [
      ...(permisosPorCopropiedad.get(id) ?? []),
    ]);
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
    coPropertyId: string,
    isPlatformAdmin = false,
  ): Promise<AccesoCopropiedad | null> {
    if (!Types.ObjectId.isValid(coPropertyId)) return null;

    const permitidas = await this.copropiedadesDe(accountId, isPlatformAdmin);
    return permitidas.find((c) => c.coPropertyId === coPropertyId) ?? null;
  }

  /** Platform operators see every active building, with no assignment needed. */
  private async todasLasCopropiedades(): Promise<AccesoCopropiedad[]> {
    const todas = await this.copropiedades
      .find({ status: 'active' })
      .select('_id code name')
      .sort({ name: 1 })
      .lean()
      .exec();

    return todas.map((c) => ({
      coPropertyId: c._id.toString(),
      codigo: c.code,
      nombre: c.name,
      // Left empty deliberately: a platform admin is granted everything by the
      // ability factory, not by carrying a copy of every permission key.
      permissions: [],
    }));
  }

  /** Loads names for the resolved ids, dropping any that is not active. */
  private async describir(
    ids: string[],
    permisosDe: (id: string) => string[],
  ): Promise<AccesoCopropiedad[]> {
    if (ids.length === 0) return [];

    const encontradas = await this.copropiedades
      .find({
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        status: 'active',
      })
      .select('_id code name')
      .sort({ name: 1 })
      .lean()
      .exec();

    return encontradas.map((c) => ({
      coPropertyId: c._id.toString(),
      codigo: c.code,
      nombre: c.name,
      permissions: permisosDe(c._id.toString()),
    }));
  }
}
