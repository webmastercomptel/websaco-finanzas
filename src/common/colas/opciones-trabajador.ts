/**
 * Lock lifetime of the lote workers (consolidación, receipts application).
 * BullMQ renews the lock from the event loop; a long synchronous step (PDF or
 * large batch work) that starves it past `lockDuration` makes the job look
 * stalled and it is picked up again IN PARALLEL — a duplicate consolidation.
 * 5 minutes equals Cloud Run's request timeout (Etapa 0): beyond it nobody is
 * waiting for the result anyway. Cost: a worker that really dies is noticed
 * only after this long (the BullMQ default is 30 s).
 */
export const LOCK_DURATION_TRABAJADOR_MS = 300_000;

/** Worker options shared by every lote `@Processor`. */
export const OPCIONES_TRABAJADOR_LOTE = {
  lockDuration: LOCK_DURATION_TRABAJADOR_MS,
} as const;
