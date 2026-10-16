// src/modules/integraciones-websaco3/propietarios.firma.ts

/**
 * Purpose tag at the head of every signed string. Binds a signature to the
 * holders pull, so a signature minted for the invoice publication
 * (`${ts}.${body}`) can never verify here, and vice versa.
 */
export const PROPOSITO = 'propietarios.v1';

/** Accepted clock skew between WebSaco3 and this server, in seconds. */
export const VENTANA_SEGUNDOS = 300;

/**
 * Splits `request.originalUrl` into the raw path and the raw query string.
 *
 * Deliberately string slicing, not `new URL(...)`: the signature must cover
 * exactly what the caller sent, and `URL` normalizes (dot segments, case of
 * escapes) — a normalization on one side only would break verification or,
 * worse, let two different requests share a signature.
 */
export function rutaYConsulta(originalUrl: string): {
  path: string;
  rawQuery: string;
} {
  const sinFragmento = originalUrl.split('#', 1)[0];
  const corte = sinFragmento.indexOf('?');
  if (corte === -1) return { path: sinFragmento, rawQuery: '' };
  return {
    path: sinFragmento.slice(0, corte),
    rawQuery: sinFragmento.slice(corte + 1),
  };
}

/**
 * Canonical form of a raw query string: `URLSearchParams` pairs sorted by key
 * then value (UTF-16 code-unit order, i.e. plain `<`), each side re-encoded
 * with `encodeURIComponent`, joined `k=v&...`. Empty string when there is no
 * query. WebSaco3 MUST implement the exact same canonicalization; the shared
 * vector in `propietarios.vector.ts` is the contract.
 */
export function consultaCanonica(rawQuery: string): string {
  const pares = Array.from(new URLSearchParams(rawQuery));
  pares.sort(([ka, va], [kb, vb]) => {
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (va !== vb) return va < vb ? -1 : 1;
    return 0;
  });
  return pares
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * The exact string that is HMAC-signed: purpose, timestamp (seconds), method
 * as received, full received path (including `/api/v1`) and canonical query,
 * LF-separated with no trailing newline.
 */
export function cadenaFirmaPropietarios(partes: {
  timestamp: string;
  method: string;
  path: string;
  rawQuery: string;
}): string {
  return [
    PROPOSITO,
    partes.timestamp,
    partes.method,
    partes.path,
    consultaCanonica(partes.rawQuery),
  ].join('\n');
}
