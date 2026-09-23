import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import { LotesFacturacionService } from '../lotes.service';
import {
  NOMBRE_COLA_CONSOLIDACION,
  type DatosTrabajoConsolidacion,
  type ResultadoConsolidacion,
} from './consolidacion.constants';

/**
 * Runs `LotesFacturacionService.ejecutarConsolidacion()` off the HTTP
 * request thread. `consolidar()` enqueues one job here and awaits its
 * result via `Job.waitUntilFinished` — the external `POST :id/consolidar`
 * contract doesn't change, only WHERE the work actually executes.
 */
@Processor(NOMBRE_COLA_CONSOLIDACION)
export class ConsolidacionProcessor extends WorkerHost {
  constructor(private readonly lotes: LotesFacturacionService) {
    super();
  }

  async process(
    job: Job<DatosTrabajoConsolidacion, ResultadoConsolidacion>,
  ): Promise<ResultadoConsolidacion> {
    return this.lotes.ejecutarConsolidacion(
      job.data.loteId,
      new Types.ObjectId(job.data.coPropertyId),
      job,
    );
  }
}
