// src/modules/publicacion-facturas/publicacion-facturas.politica.ts

/**
 * Pure constants and functions governing retry timing, budgets, and how a
 * WebSaco3 response classifies. No NestJS DI, no I/O — see design.md's
 * "Policy" section for the exact values and their rationale.
 */

/** 1m, 5m, 15m, 1h — clamped to the last value beyond this length. */
export const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000] as const;

/** Must exceed FETCH_TIMEOUT_MS plus URL-signing time, so a genuinely
 *  in-flight attempt is never mistaken for a stale, crashed claim. */
export const CLAIM_TTL_MS = 5 * 60_000;

export const FETCH_TIMEOUT_MS = 15_000;

/** Long enough that a receiver answering 202 (accepted, download later) has
 *  time to actually fetch the file asynchronously. */
export const URL_LECTURA_TTL_MS = 60 * 60_000;

export const LOTE_MAXIMO_POR_CICLO = 25;

/** Must stay below both Cloud Scheduler's default HTTP attempt deadline
 *  (180s) and Cloud Run's default request timeout (300s), and below
 *  CLAIM_TTL_MS, so a cycle never outlives the claims it took. */
export const PRESUPUESTO_CICLO_MS = 120_000;

/**
 * Backoff delay before the NEXT attempt, given how many attempts have
 * already happened (1-indexed, matching the `attempts` counter incremented
 * at claim time). Clamps to the last step of `BACKOFF_MS` beyond its length.
 */
export function retrasoTras(attempts: number): number {
  const index = Math.min(attempts - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[Math.max(index, 0)];
}

export type Clasificacion = 'enviado' | 'reintentar' | 'terminal';

/**
 * Maps a WebSaco3 HTTP response status to how the outbox row should
 * transition. 200-299 and 409 (already-received, treated as success — the
 * receiver's own idempotency) mean `enviado`. 422/429/500-599 are
 * transient and get `reintentar`. 401/403 are `terminal` — the credentials
 * are wrong, and no retry fixes that.
 *
 * `[spec-gap]`: the spec's table lists only 201/202/409/422/502/401/403.
 * This extends the terminal bucket to any OTHER 4xx (400, 404, 413...) —
 * codes the receiver contract does not promise not to ever send, and a
 * client error is never fixed by re-sending the identical request.
 */
export function clasificarRespuesta(status: number): Clasificacion {
  if ((status >= 200 && status < 300) || status === 409) return 'enviado';
  if (status === 422 || status === 429 || status >= 500) return 'reintentar';
  return 'terminal';
}
