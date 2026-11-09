import * as Sentry from '@sentry/node';

export interface OpcionesSentry {
  /** SENTRY_DSN; absent or empty = Sentry stays off. */
  dsn: string | undefined;
  /** NODE_ENV, reported as the Sentry environment. */
  env: string | undefined;
  /** Optional build/revision label (Cloud Run's K_REVISION). */
  release?: string;
}

/**
 * Starts error reporting when a DSN is configured; returns whether it did.
 * Must run before the app is created. Deliberately minimal: no tracing and no
 * default PII (request bodies and headers carry invoice and resident data),
 * so only the stack and the exception reach Sentry. Without a DSN nothing is
 * initialised and `captureException` is a no-op.
 */
export function iniciarSentry({ dsn, env, release }: OpcionesSentry): boolean {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: env,
    release,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  return true;
}
