// src/modules/publicacion-facturas/publicacion-facturas.firma.ts
import { createHmac } from 'node:crypto';

/**
 * Signs `${timestamp}.${rawBody}` with HMAC-SHA256, hex-encoded.
 *
 * `rawBody` MUST be the exact string sent as the `fetch` body — computed
 * ONCE by the caller and passed here unchanged, never re-serialized. The
 * receiver verifies over the raw request bytes before JSON parsing (see
 * design.md's cross-repo contract note); any re-serialization on either side
 * (whitespace, key order, unicode escaping) makes every signature fail
 * silently.
 */
export function firmar(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
}
