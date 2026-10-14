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

/**
 * Hard timeout of the outbound POST to WebSaco3. 45 s because the receiver
 * runs on Cloud Run and scales to zero: after idle time the first request
 * waits for a cold start (Node boot plus the Mongo connection, typically
 * 5-30 s) before it is answered. A shorter timeout (the former 15 s) would
 * turn an ordinary cold start into a retryable `fallido`, and nothing
 * retries those automatically: there is no scheduler, an operator has to
 * run the manual sweep.
 *
 * Not longer, on purpose: the send is awaited INSIDE the confirm-PDF
 * request (`publicarAhora`), so a receiver that hangs while warm makes the
 * user wait the whole timeout, and anything past 45 s is an incident rather
 * than a cold start. Worst case for that request is roughly 55 s (its own
 * work, URL signing, plus this), well under Cloud Run's default 300 s.
 *
 * Not an env var: it is coupled to the invariants checked in
 * `publicacion-facturas.politica.spec.ts` (`CLAIM_TTL_MS`,
 * `PRESUPUESTO_CICLO_MS`), so changing it is a code change with its test.
 */
export const FETCH_TIMEOUT_MS = 45_000;

/** Margin added to FETCH_TIMEOUT_MS when deciding whether the cycle has
 *  room left to claim one more row — covers URL signing plus the claim's
 *  own round trip, which aren't captured by FETCH_TIMEOUT_MS alone. */
export const MARGEN_CICLO_MS = 5_000;

/** Long enough that a receiver answering 202 (accepted, download later) has
 *  time to actually fetch the file asynchronously. */
export const URL_LECTURA_TTL_MS = 60 * 60_000;

export const LOTE_MAXIMO_POR_CICLO = 25;

/**
 * Time budget of one manual sweep (`procesarPendientes`). The sweep is run by
 * an operator with `curl` (see the runbook; there is no Cloud Scheduler job),
 * so it must stay below the `--max-time 150` the runbook gives that `curl`,
 * below Cloud Run's default request timeout (300s), and below CLAIM_TTL_MS, so
 * a cycle never outlives the claims it took. It must also leave room for at
 * least one send: `FETCH_TIMEOUT_MS + MARGEN_CICLO_MS` is checked against it
 * (see the invariants in `publicacion-facturas.politica.spec.ts`).
 */
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
 * transient and get `reintentar`. Every other 4xx is `terminal`, since a
 * client error is never fixed by re-sending the identical request:
 * 401/403 mean the credentials are wrong, 400 means WebSaco3 rejected the
 * coproperty id as malformed and 404 that it does not know it (the receiver
 * contract), and anything else (413...) is equally unrecoverable.
 */
export function clasificarRespuesta(status: number): Clasificacion {
  if ((status >= 200 && status < 300) || status === 409) return 'enviado';
  if (status === 422 || status === 429 || status >= 500) return 'reintentar';
  return 'terminal';
}
