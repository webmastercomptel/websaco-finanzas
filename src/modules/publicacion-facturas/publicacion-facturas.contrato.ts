// src/modules/publicacion-facturas/publicacion-facturas.contrato.ts

/**
 * Shapes for this module's TWO outward-facing contracts. Kept inside the
 * module (design decision #6), not in `src/contracts/`: `contracts/` holds
 * THIS API's own Spanish shapes; `PayloadPublicacionLote` is WebSaco3's
 * inbound shape instead, and it should be deleted along with this module on
 * rollback.
 */

/**
 * The outbound payload sent to WebSaco3's receiver, built by
 * `construirPayload` (publicacion-facturas.mapper.ts). Field order here is
 * cosmetic — `JSON.stringify` output order follows insertion order of these
 * keys, and the receiver verifies over raw bytes, not a re-parsed object, so
 * key order never matters to the signature (see the HMAC contract note in
 * design.md).
 */
export interface PayloadPublicacionLote {
  nit: string;
  loteId: string;
  facturas: { numeroFactura: string }[];
  urlSigned: string;
  /** ISO-8601. */
  urlExpiresAt: string;
}

/** Returned by `POST /interno/publicacion-facturas/procesar-pendientes` —
 *  a summary of one sweep cycle, never row-level detail (rows are internal
 *  state, not exposed to the trigger caller). */
export interface ResumenCiclo {
  /** `true` when a concurrent cycle was already running on this instance and
   *  this call did nothing. */
  omitido: boolean;
  reclamadas: number;
  enviadas: number;
  reintentar: number;
  terminales: number;
}
