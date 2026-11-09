// src/common/proceso/rol-proceso.ts

/**
 * What a process of this backend is for. `all` is today's behaviour (one
 * service does everything); `api` only answers HTTP; `worker` also answers HTTP
 * (Cloud Run needs a listening port) but is the one that runs the background
 * consumers. The split exists so a heavy lote can later run on its own service
 * without redeploying the code.
 */
export const ROLES_PROCESO = ['all', 'api', 'worker'] as const;
export type RolProceso = (typeof ROLES_PROCESO)[number];

/** BullMQ workers (lote consolidation, receipts application) run here. */
export const ejecutaTrabajadoresDeCola = (rol: RolProceso): boolean =>
  rol !== 'api';

/** `@Cron` jobs and the start-up catch-up pass run here. */
export const ejecutaTareasProgramadas = (rol: RolProceso): boolean =>
  rol !== 'api';

// Module state, same device as `scripts/script-mode.ts`: the cron wrapper has
// no ConfigService and must not read `process.env` itself. Written once by
// `RolProcesoService` during module init, before any bootstrap hook runs.
let rolActual: RolProceso = 'all';

/** Records the role of this process (called by `RolProcesoService`). */
export function establecerRolProceso(rol: RolProceso): void {
  rolActual = rol;
}

/** The role of this process; `all` until `establecerRolProceso` says otherwise. */
export function rolProcesoActual(): RolProceso {
  return rolActual;
}
