// src/modules/portal/portal-acceso.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  correoProbado,
  unidadesDeTerceros,
} from '../../common/acceso/residencia.reglas';
import { ResidenciaService } from '../../common/acceso/residencia.service';
import type { CuentaParaAcceso } from '../../common/acceso/acceso.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { claveCorreo } from '../../common/utils/email.utils';

/** How a resident relates to one unit. The role is per unit, not per person. */
export type RolPortal = 'propietario' | 'arrendatario';

/** One unit a resident may see, with the role they hold on it. */
export interface UnidadPortal {
  inmuebleId: string;
  codigo: string;
  rol: RolPortal;
}

/**
 * The Account slice the auth guard already put on the request (address and
 * proof), so a portal request costs no re-read of the Account. Undefined when
 * the request user does not carry the proof field at all: "not loaded" must
 * not read as "no proof", so the service then re-reads the Account.
 */
export function cuentaParaAccesoDe(
  user: IRequestUser,
): CuentaParaAcceso | undefined {
  if (user.correoProbadoClave === undefined) return undefined;
  return { email: user.email, correoProbadoClave: user.correoProbadoClave };
}

/**
 * Resolves which units an account holds as owner or tenant.
 *
 * Access is DERIVED, never stored. The parties of an account are the union of
 * two routes: the legacy link (`Tercero.accountId`) and, for an account that
 * PROVED its address, every active party of this coproperty whose `emails`
 * carry it (several records, several units, several roles). The units are those
 * where one of those parties is the `titularId` (owner) or `arrendatarioId`
 * (tenant), each once, owner winning. An active revocation of the account's
 * address in this coproperty removes everything, on both routes. Changing who
 * holds a unit therefore changes what they can see with no sync step to forget.
 *
 * The role is per unit: the same person can own A-1 and rent B-2. A resident
 * has no CASL permissions at all; the portal routes authorize through this
 * list, so an id outside it is treated as not existing.
 */
@Injectable()
export class PortalAccesoService {
  constructor(
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    private readonly residencia: ResidenciaService,
  ) {}

  /**
   * Active units of the coproperty held by this account, ordered by code.
   * `cuenta`: the Account as the request already holds it
   * (`cuentaParaAccesoDe`); without it the Account is re-read by `_id`.
   */
  async unidadesDe(
    accountId: string,
    copropiedadId: string,
    cuentaDePeticion?: CuentaParaAcceso,
  ): Promise<UnidadPortal[]> {
    const copropiedad = new Types.ObjectId(copropiedadId);

    // Legacy route: the party linked to the account in this coproperty.
    const vinculado = await this.terceros
      .findOne({
        copropiedadId: copropiedad,
        accountId: new Types.ObjectId(accountId),
        estado: 'active',
      })
      .select('_id')
      .lean()
      .exec();

    // The Account carries the address, its proof and the revocation key.
    const cuenta =
      cuentaDePeticion ??
      (await this.cuentas
        .findById(accountId)
        .select('email estado correoProbadoClave')
        .lean()
        .exec());

    // Proven route: parties of THIS coproperty that carry the proven address.
    const partes = new Set<string>(vinculado ? [vinculado._id.toString()] : []);
    if (cuenta && correoProbado(cuenta)) {
      for (const parte of await this.residencia.tercerosPorCorreo(
        cuenta.email,
      )) {
        if (parte.copropiedadId === copropiedadId) partes.add(parte.id);
      }
    }
    if (partes.size === 0) return [];

    if (cuenta) {
      const revocadas = await this.residencia.revocacionesActivas(
        claveCorreo(cuenta.email),
        [copropiedadId],
      );
      if (revocadas.has(copropiedadId)) return [];
    }

    const ids = [...partes].map((id) => new Types.ObjectId(id));
    const unidades = await this.inmuebles
      .find({
        copropiedadId: copropiedad,
        estado: 'active',
        $or: [{ titularId: { $in: ids } }, { arrendatarioId: { $in: ids } }],
      })
      .select('_id codigo titularId arrendatarioId')
      .sort({ codigo: 1 })
      .lean()
      .exec();

    // The rule decides which units count and in which role (owner wins), so a
    // unit whose record does not carry these parties never gets through.
    const roles = new Map(
      unidadesDeTerceros(
        [...partes].map((id) => ({ id, copropiedadId })),
        unidades.map((u) => ({
          id: u._id.toString(),
          copropiedadId,
          titularId: u.titularId?.toString() ?? null,
          arrendatarioId: u.arrendatarioId?.toString() ?? null,
        })),
      ).map((u) => [u.inmuebleId, u.rol] as const),
    );

    return unidades.flatMap((u) => {
      const rol = roles.get(u._id.toString());
      return rol
        ? [{ inmuebleId: u._id.toString(), codigo: u.codigo, rol }]
        : [];
    });
  }

  /** The caller's role on one unit, or null when the unit is not theirs. */
  async rolEn(
    accountId: string,
    copropiedadId: string,
    inmuebleId: string,
    cuenta?: CuentaParaAcceso,
  ): Promise<RolPortal | null> {
    const unidades = await this.unidadesDe(accountId, copropiedadId, cuenta);
    return unidades.find((u) => u.inmuebleId === inmuebleId)?.rol ?? null;
  }
}
