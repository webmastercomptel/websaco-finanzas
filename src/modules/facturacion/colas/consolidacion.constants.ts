import type {
  ErrorConsolidacion,
  LoteFacturacion as LoteContract,
} from '../../../contracts';

/** BullMQ queue name for `consolidar()`'s background job — see
 *  `LotesFacturacionService.consolidar()`'s own docblock for why this
 *  exists (moving the heavy per-row work off the HTTP request thread). */
export const NOMBRE_COLA_CONSOLIDACION = 'consolidacion-lotes';

/** The one job name this queue ever uses — BullMQ requires one, but this
 *  queue never carries more than a single kind of job. */
export const NOMBRE_TRABAJO_CONSOLIDACION = 'consolidar';

/** DI token for the shared `QueueEvents` instance `consolidar()` awaits a
 *  job's result through (`Job.waitUntilFinished`) — a plain factory
 *  provider, not `@InjectQueue`, since BullMQ has no decorator for it. */
export const EVENTOS_COLA_CONSOLIDACION = Symbol('EVENTOS_COLA_CONSOLIDACION');

export type DatosTrabajoConsolidacion = {
  loteId: string;
  /** Serialized `ObjectId` — a job runs outside any HTTP request's CLS
   *  context, so it can never resolve the tenant itself; the caller
   *  resolves it once and hands it over as plain data. */
  coPropertyId: string;
};

export type ResultadoConsolidacion = {
  lote: LoteContract;
  errores: ErrorConsolidacion[];
};
