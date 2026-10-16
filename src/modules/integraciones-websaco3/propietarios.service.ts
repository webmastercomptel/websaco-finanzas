// src/modules/integraciones-websaco3/propietarios.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import type { PropietariosWebsaco3 } from '../../contracts';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Inmueble,
  type InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  type TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import {
  mapearPropietarios,
  type InmuebleParaPropietarios,
  type TerceroParaPropietarios,
} from './propietarios.mapper';

/** Largest coproperty the snapshot answers for; one more is refused. */
const MAX_UNIDADES = 2000;

/**
 * Builds the holders snapshot WebSaco3 pulls. It takes the coproperty from
 * the signed query and NEVER injects `TenantContextService`: the caller is a
 * machine with no user and no CLS tenant, and the tenant IS the coproperty
 * looked up here. Every following filter carries its `_id`, which satisfies
 * the tenancy law by construction (no `findById` on tenant data).
 *
 * Read-only; two bounded queries however many units there are.
 */
@Injectable()
export class PropietariosService {
  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
  ) {}

  /** @param websaco3CopropiedadId already lowercased by the query DTO. */
  async obtener(websaco3CopropiedadId: string): Promise<PropietariosWebsaco3> {
    // `limit(2)` is enough to tell "one" from "legacy duplicates". The
    // coproperty `estado` is deliberately not a filter (contract: id + flag).
    const encontradas = await this.copropiedades
      .find({ websaco3CopropiedadId, usaGestionEdificios: true })
      .select('_id nombre')
      .limit(2)
      .lean<Array<{ _id: Types.ObjectId; nombre: string }>>();

    if (encontradas.length === 0) {
      throw new NotFoundException(
        'No hay una copropiedad con gestión de edificios vinculada a ese id.',
      );
    }
    if (encontradas.length > 1) {
      throw new ConflictException(
        'Más de una copropiedad tiene ese id de WebSaco3; hay que corregirlo.',
      );
    }
    const [copropiedad] = encontradas;

    // MAX + 1 is read only to detect the overflow without loading more.
    const inmuebles = await this.inmuebles
      .find({ copropiedadId: copropiedad._id })
      .select('codigo titularId tipoTitular')
      .sort({ codigo: 1 })
      .limit(MAX_UNIDADES + 1)
      .lean<InmuebleParaPropietarios[]>();

    if (inmuebles.length > MAX_UNIDADES) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'demasiadas-unidades',
        message: `La copropiedad supera las ${MAX_UNIDADES} unidades que admite la sincronización.`,
      });
    }

    const titularIds = this.titularesDistintos(inmuebles);
    // The `$in` + `copropiedadId` filter makes a titular of another tenant
    // simply unresolved (`titular: null`), never a leak.
    const terceros =
      titularIds.length === 0
        ? []
        : await this.terceros
            .find({
              copropiedadId: copropiedad._id,
              _id: { $in: titularIds },
              estado: 'active',
            })
            .select('nombre emails telefono estado')
            .lean<TerceroParaPropietarios[]>();

    return mapearPropietarios(copropiedad, inmuebles, terceros);
  }

  private titularesDistintos(
    inmuebles: InmuebleParaPropietarios[],
  ): Types.ObjectId[] {
    const vistos = new Map<string, Types.ObjectId>();
    for (const { titularId } of inmuebles) {
      if (titularId) vistos.set(String(titularId), titularId);
    }
    return [...vistos.values()];
  }
}
