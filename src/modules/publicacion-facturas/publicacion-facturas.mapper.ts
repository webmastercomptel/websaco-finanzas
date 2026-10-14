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
 * Pure function building the outbound payload from an outbox row, the
 * WebSaco3 coproperty id resolved from the CURRENT `Copropiedad` at send
 * time, and a freshly issued signed URL. The id is a parameter, never read
 * from the row: the row does not snapshot identity, so a corrected id also
 * reaches rows already queued, and a stale `nit` left on a legacy row can
 * never leak into the payload. `numerosFactura` order is preserved verbatim —
 * it is the row's own frozen snapshot of the PDF's page order, and this
 * mapper has no business reordering it.
 */
export function construirPayload(
  fila: FilaPublicacionLote,
  websaco3CopropiedadId: string,
  url: string,
  expiresAt: Date,
): PayloadPublicacionLote {
  return {
    websaco3CopropiedadId,
    loteId: fila.loteId.toString(),
    facturas: fila.numerosFactura.map((numeroFactura) => ({ numeroFactura })),
    urlSigned: url,
    urlExpiresAt: expiresAt.toISOString(),
  };
}
