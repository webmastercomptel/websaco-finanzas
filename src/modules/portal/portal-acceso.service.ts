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

/** How a resident relates to one unit. The role is per unit, not per person. */
export type RolPortal = 'propietario' | 'arrendatario';

/** One unit a resident may see, with the role they hold on it. */
export interface UnidadPortal {
  inmuebleId: string;
  codigo: string;
  rol: RolPortal;
}

/**
 * Resolves which units an account holds as owner or tenant.
 *
 * Access is DERIVED, never stored: the account is linked to a `Tercero`
 * (`accountId`), and that `Tercero` is the `titularId` (owner) or
 * `arrendatarioId` (tenant) of units. Changing who holds a unit therefore
 * changes what they can see with no sync step to forget.
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
  ) {}

  /** Active units of the coproperty held by this account, ordered by code. */
  async unidadesDe(
    accountId: string,
    copropiedadId: string,
  ): Promise<UnidadPortal[]> {
    const copropiedad = new Types.ObjectId(copropiedadId);

    const tercero = await this.terceros
      .findOne({
        copropiedadId: copropiedad,
        accountId: new Types.ObjectId(accountId),
        estado: 'active',
      })
      .select('_id')
      .lean()
      .exec();
    if (!tercero) return [];

    const unidades = await this.inmuebles
      .find({
        copropiedadId: copropiedad,
        estado: 'active',
        $or: [{ titularId: tercero._id }, { arrendatarioId: tercero._id }],
      })
      .select('_id codigo titularId arrendatarioId')
      .sort({ codigo: 1 })
      .lean()
      .exec();

    return unidades.map((u) => ({
      inmuebleId: u._id.toString(),
      codigo: u.codigo,
      // Owner wins if both ever pointed at the same party (the write path
      // forbids it, but a legacy row must not downgrade an owner).
      rol:
        u.titularId?.toString() === tercero._id.toString()
          ? 'propietario'
          : 'arrendatario',
    }));
  }

  /** The caller's role on one unit, or null when the unit is not theirs. */
  async rolEn(
    accountId: string,
    copropiedadId: string,
    inmuebleId: string,
  ): Promise<RolPortal | null> {
    const unidades = await this.unidadesDe(accountId, copropiedadId);
    return unidades.find((u) => u.inmuebleId === inmuebleId)?.rol ?? null;
  }
}
