// src/modules/publicacion-facturas/publicacion-facturas.mapper.ts
import type { Types } from 'mongoose';
import type { PayloadPublicacionLote } from './publicacion-facturas.contrato';

/** The subset of `PublicacionLote` this mapper needs — decoupled from the
 *  Mongoose document/lean type so it stays a pure function of plain data. */
export interface FilaPublicacionLote {
  loteId: Types.ObjectId | string;
  numerosFactura: string[];
}

/**
 * `AAAA-MM` of a lote's `periodoDesde`, or `undefined` when there is no usable
 * date (the receiver then falls back on its own month of receipt).
 *
 * Reads the UTC month on purpose: `periodoDesde` is a bare "YYYY-MM-DD" stored
 * as UTC midnight, and the UI titles the lote with the same UTC month
 * (`formatoMesAnio` in the frontend's `selector-lote-modal.tsx`). A Bogotá
 * (UTC-5) conversion would roll `2026-11-01T00:00Z` back to October, so the
 * document would not match the lote title the user sees.
 */
export function periodoDeLote(
  periodoDesde: Date | null | undefined,
): string | undefined {
  if (!(periodoDesde instanceof Date) || Number.isNaN(periodoDesde.getTime())) {
    return undefined;
  }
  return periodoDesde.toISOString().slice(0, 7);
}

/**
 * Pure function building the outbound payload from an outbox row, the
 * WebSaco3 coproperty id resolved from the CURRENT `Copropiedad` at send
 * time, and a freshly issued signed URL. The id is a parameter, never read
 * from the row: the row does not snapshot identity, so a corrected id also
 * reaches rows already queued, and a stale `nit` left on a legacy row can
 * never leak into the payload. `periodo` follows the same philosophy (read
 * from the lote at send time) and is omitted, not nulled, when unknown, so
 * the body stays identical to the pre-`periodo` contract. `numerosFactura`
 * order is preserved verbatim — it is the row's own frozen snapshot of the
 * PDF's page order, and this mapper has no business reordering it.
 */
export function construirPayload(
  fila: FilaPublicacionLote,
  websaco3CopropiedadId: string,
  url: string,
  expiresAt: Date,
  periodo?: string,
): PayloadPublicacionLote {
  return {
    websaco3CopropiedadId,
    loteId: fila.loteId.toString(),
    facturas: fila.numerosFactura.map((numeroFactura) => ({ numeroFactura })),
    urlSigned: url,
    urlExpiresAt: expiresAt.toISOString(),
    ...(periodo ? { periodo } : {}),
  };
}
