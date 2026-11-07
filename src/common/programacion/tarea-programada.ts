// src/common/programacion/tarea-programada.ts
import type { Logger } from '@nestjs/common';
import type { LockService } from '../redis/lock.service';
import { isScriptEnvMode } from '../scripts/script-mode';

/** Lock name and its auto-expiry (must exceed the task's worst-case duration). */
export interface OpcionesTareaProgramada {
  clave: string;
  ttlMs: number;
}

/**
 * Runs a scheduled job on exactly one instance and never lets it throw.
 *
 * A `@Cron` handler that rejects becomes an unhandled rejection in the
 * scheduler's timer, and the cleanup jobs this wraps are all idempotent state
 * changes: a failed pass is logged and simply tried again at the next tick.
 * Returns true only when this instance won the lock AND the task completed.
 */
export async function ejecutarTareaProgramada(
  lock: LockService,
  logger: Logger,
  { clave, ttlMs }: OpcionesTareaProgramada,
  tarea: () => Promise<void>,
): Promise<boolean> {
  try {
    return await lock.runExclusive(clave, ttlMs, tarea);
  } catch (error: unknown) {
    logger.error(
      `La tarea programada ${clave} falló: ${(error as Error).message}`,
    );
    return false;
  }
}

/**
 * Runs a catch-up pass in the background once the process is up.
 *
 * Cloud Run scales to zero, so a midnight `@Cron` only fires when an instance
 * happens to be awake at that time. Calling this from `onApplicationBootstrap`
 * makes the first instance of the day put the cleanup up to date. It does not
 * delay boot (deferred to the next tick, never awaited) and a failure is only
 * logged. The task must go through `ejecutarTareaProgramada` so the lock keeps
 * several instances from running it at once.
 *
 * Skipped in a script that chose its environment with `--env` (seeds,
 * migrations): booting the application context for a one-off script must not
 * trigger the server's background work against whatever database it targets.
 */
export function ejecutarAlArrancar(
  logger: Logger,
  nombre: string,
  tarea: () => Promise<unknown>,
): void {
  if (isScriptEnvMode()) return;
  setImmediate(() => {
    void tarea().catch((error: unknown) => {
      logger.error(
        `La pasada inicial de ${nombre} falló: ${(error as Error).message}`,
      );
    });
  });
}
