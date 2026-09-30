import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import { LoteRecibosService } from '../lote-recibos.service';
import {
  NOMBRE_COLA_APLICACION_LOTE_RECIBOS,
  type DatosTrabajoAplicacionLoteRecibos,
  type ResultadoAplicacionLoteRecibos,
} from './aplicacion-lote-recibos.constants';

@Processor(NOMBRE_COLA_APLICACION_LOTE_RECIBOS)
export class AplicacionLoteRecibosProcessor extends WorkerHost {
  constructor(private readonly loteRecibos: LoteRecibosService) {
    super();
  }

  async process(
    job: Job<DatosTrabajoAplicacionLoteRecibos, ResultadoAplicacionLoteRecibos>,
  ): Promise<ResultadoAplicacionLoteRecibos> {
    return this.loteRecibos.ejecutarAplicacion(
      job.data.loteId,
      new Types.ObjectId(job.data.copropiedadId),
      job.data.accountId,
      job,
    );
  }
}
