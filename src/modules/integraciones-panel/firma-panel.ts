// src/modules/integraciones-panel/firma-panel.ts

/**
 * Signature scheme of the integrations panel (integraciones.comptel.com.co),
 * identical on both sides and on the other three systems: the panel's
 * `common/hmac/firma.ts` and this file must produce the same string. A golden
 * vector pins it in `firma-panel.guard.spec.ts`.
 */
export const HEADER_TIMESTAMP = 'x-websaco-timestamp';
export const HEADER_FIRMA = 'x-websaco-signature';
export const PREFIJO_FIRMA = 'sha256=';

/** Accepted clock skew, in seconds, in either direction. */
export const VENTANA_SEGUNDOS = 300;

/**
 * The signed string: `${timestamp}.${METODO}.${ruta}.${rawBody}`. Method and
 * route are part of it so a signature is good for one request purpose only;
 * `ruta` is the pathname plus query exactly as received (with `/api/v1`).
 */
export function cadenaFirma(partes: {
  timestamp: string;
  metodo: string;
  ruta: string;
  rawBody: string;
}): string {
  return `${partes.timestamp}.${partes.metodo.toUpperCase()}.${partes.ruta}.${partes.rawBody}`;
}
