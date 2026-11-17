import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Model } from 'mongoose';
import {
  ESTADOS_PQR_LEGADOS,
  Pqr,
} from '../../database/schemas/administracion/pqr.schema';

export const MENSAJE_PQR_ESTADOS_ANTERIORES =
  'Hay PQRS con estados anteriores: ejecuta npm run migrar:estados-pqr -- --env=<ambiente> --aplicar';

export const MENSAJE_PQR_ESTADOS_NO_COMPROBADO =
  'No se pudo comprobar los estados de PQRS.';

/**
 * Informational readiness note of the PQRS four-stage conversion (backend rule
 * 10, runbook `docs/runbooks/pqrs-etapas.md`). It NEVER fails: `/health/ready`
 * is the Cloud Run startup probe (`docs/runbooks/despliegue-fusion.md`) and the
 * new backend reads legacy `estado` values correctly by design, so pending rows
 * are not a malfunction and must not keep a revision from becoming ready.
 * Legacy rows found -> up with a `pendiente` note naming the command; a Mongo
 * error or timeout -> up with `omitido`, never echoing the error. One bounded
 * read (`maxTimeMS` 2 s), no third service.
 */
@Injectable()
export class PqrEstadosHealthIndicator extends HealthIndicator {
  constructor(@InjectModel(Pqr.name) private readonly pqr: Model<Pqr>) {
    super();
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    try {
      const pendiente = await this.pqr
        .findOne({ estado: { $in: [...ESTADOS_PQR_LEGADOS] } }, { _id: 1 })
        .maxTimeMS(2000)
        .lean()
        .exec();
      if (pendiente) {
        return this.getStatus(key, true, {
          pendiente: MENSAJE_PQR_ESTADOS_ANTERIORES,
        });
      }
      return this.getStatus(key, true);
    } catch {
      return this.getStatus(key, true, {
        omitido: MENSAJE_PQR_ESTADOS_NO_COMPROBADO,
      });
    }
  }
}
