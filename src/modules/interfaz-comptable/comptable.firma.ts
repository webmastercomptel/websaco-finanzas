// src/modules/interfaz-comptable/comptable.firma.ts
import { hmacSha256Hex } from '../../common/utils/hmac';

/** The four parts the Comptable receiver re-derives from the request it got. */
export interface PartesFirma {
  /** Unix seconds, the exact string sent in `X-Websaco-Timestamp`. */
  timestamp: string;
  /** HTTP method; upper-cased here so a caller cannot sign `post` and send `POST`. */
  metodo: string;
  /** URL path + query exactly as sent, INCLUDING Comptable's `/api/v1` prefix. */
  ruta: string;
  /** The exact string sent as the body; `''` for a bodyless request. */
  rawBody: string;
}

/**
 * The purpose-bound string Comptable verifies:
 * `${timestamp}.${METHOD}.${ruta}.${rawBody}`. Binding method and path means a
 * signature captured on one route (say, a simulated lote) is useless on any
 * other (the real send, or a retiro), unlike the WebSaco3 publication, whose
 * single route lets it sign `${timestamp}.${rawBody}` alone.
 */
export function cadenaFirma(partes: PartesFirma): string {
  return `${partes.timestamp}.${partes.metodo.toUpperCase()}.${partes.ruta}.${partes.rawBody}`;
}

/**
 * HMAC-SHA256 hex of `cadenaFirma`, on Santiago's shared primitive. `rawBody`
 * MUST be the string handed to `fetch` unchanged: Comptable verifies over the
 * raw bytes it received, so any re-serialization between signing and sending
 * fails every request.
 */
export function firmarComptable(secreto: string, partes: PartesFirma): string {
  return hmacSha256Hex(secreto, cadenaFirma(partes));
}
