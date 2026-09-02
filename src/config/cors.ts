// src/config/cors.ts
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/** Origin callback shape expected by the cors middleware. */
type OriginCallback = (err: Error | null, allow?: boolean) => void;

/** Any port on the machine running the browser. */
const isLocalhost = (origin: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const parseList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

/**
 * Builds the CORS policy.
 *
 * Production takes an explicit allow-list and nothing else. Development, with
 * no list configured, accepts any localhost origin — deliberately, because Vite
 * moves to another port whenever the default is busy, and a policy that breaks
 * when the dev server picks 5174 would be "fixed" by whoever hits it in the
 * fastest way available, which is opening it to everything.
 *
 * The relaxation is bounded to loopback: those origins are the developer's own
 * machine, and this is the same shape as REDIS_PASSWORD — relaxed in dev,
 * demanded in production.
 *
 * @param env The value of NODE_ENV.
 * @param raw Comma-separated origins from CORS_ORIGINS.
 */
export function corsOptionsFor(
  env: string | undefined,
  raw: string | undefined,
): CorsOptions {
  const permitidos = parseList(raw);
  const esProduccion = env === 'production';

  return {
    origin: (origin: string | undefined, callback: OriginCallback) => {
      // No Origin header: same-origin, curl, a health probe. Not a browser
      // cross-origin request, so there is nothing for CORS to decide.
      if (!origin) return callback(null, true);

      const limpio = origin.replace(/\/$/, '');
      if (permitidos.includes('*')) return callback(null, true);
      if (permitidos.includes(limpio)) return callback(null, true);
      if (!esProduccion && isLocalhost(limpio)) return callback(null, true);

      // Deny by answering "not allowed", never by throwing: an error here
      // becomes a 500 and hides a policy decision behind a server fault.
      return callback(null, false);
    },
    // The browser must be allowed to send the token and, later, the active
    // coproperty. Omitting these makes the preflight fail with a message that
    // says nothing about which header was the problem.
    allowedHeaders: ['Authorization', 'Content-Type', 'X-CoProperty-Id'],
    // Cookies are not used — the session travels in the Authorization header.
    // Leaving this false is what keeps the localhost relaxation above safe:
    // credentials:true plus a permissive origin is the classic CORS hole.
    credentials: false,
  };
}
