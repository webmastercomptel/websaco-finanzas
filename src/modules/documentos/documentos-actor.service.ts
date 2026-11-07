// src/modules/documentos/documentos-actor.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AccesoService } from '../../common/acceso/acceso.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  Account,
  type AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Asignacion,
  type AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import {
  PERMISO_GESTIONAR_DOCUMENTOS,
  type ActorDocumentos,
} from './documentos-acceso';

/** Whether the caller administers every folder (platform admin or `gestionar`). */
export const puedeGestionar = (
  user: Pick<IRequestUser, 'isPlatformAdmin' | 'permissions'>,
): boolean =>
  user.isPlatformAdmin === true ||
  (user.permissions ?? []).includes(PERMISO_GESTIONAR_DOCUMENTOS);

/**
 * Builds the `ActorDocumentos` a folder rule is evaluated against.
 *
 * The request user does not carry role ids (the auth guard flattens roles into
 * permission keys), so they are read here from the caller's direct assignment to
 * the ACTIVE coproperty. Only that assignment counts: roles belong to one
 * building, and an assignment to a managing company carries none. The
 * consequence, kept on purpose: company-wide staff reach folders only through
 * `gestionar`, never through a role rule.
 */
@Injectable()
export class DocumentosActorService {
  constructor(
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    private readonly acceso: AccesoService,
    private readonly tenant: TenantContextService,
  ) {}

  /** The signed-in caller. A `gestionar` holder needs no role lookup at all. */
  async deSolicitud(user: IRequestUser): Promise<ActorDocumentos> {
    if (puedeGestionar(user)) return { roleIds: new Set(), gestiona: true };
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      return { roleIds: new Set(), gestiona: false };
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const mapa = await this.rolesDe([user.accountId], copropiedadId);
    return {
      roleIds: mapa.get(user.accountId) ?? new Set(),
      gestiona: false,
    };
  }

  private async rolesDe(
    accountIds: string[],
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, Set<string>>> {
    const asignaciones = await this.asignaciones
      .find({
        accountId: { $in: accountIds.map((id) => new Types.ObjectId(id)) },
        copropiedadId,
        alcance: 'copropiedad',
        estado: 'active',
      })
      .select('accountId roleIds')
      .lean()
      .exec();
    const mapa = new Map<string, Set<string>>();
    for (const a of asignaciones) {
      const actuales = mapa.get(a.accountId.toString()) ?? new Set<string>();
      for (const id of a.roleIds ?? []) actuales.add(id.toString());
      mapa.set(a.accountId.toString(), actuales);
    }
    return mapa;
  }

  /**
   * Several staff accounts at once (the audience of a notification), resolved
   * through the same `AccesoService` that guards the routes so the verdict
   * matches what each person would get on a request.
   */
  async deCuentas(
    accountIds: string[],
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, ActorDocumentos>> {
    const validos = accountIds.filter((id) => Types.ObjectId.isValid(id));
    const actores = new Map<string, ActorDocumentos>();
    if (validos.length === 0) return actores;

    const [roles, cuentas] = await Promise.all([
      this.rolesDe(validos, copropiedadId),
      this.cuentas
        .find({ _id: { $in: validos.map((id) => new Types.ObjectId(id)) } })
        .select('esAdministradorPlataforma')
        .lean()
        .exec(),
    ]);
    const admins = new Set(
      cuentas
        .filter((c) => c.esAdministradorPlataforma)
        .map((c) => c._id.toString()),
    );

    for (const id of validos) {
      const acceso = await this.acceso.accesoA(id, copropiedadId.toString());
      actores.set(id, {
        roleIds: roles.get(id) ?? new Set(),
        gestiona:
          admins.has(id) ||
          (acceso?.permissions ?? []).includes(PERMISO_GESTIONAR_DOCUMENTOS),
      });
    }
    return actores;
  }
}
