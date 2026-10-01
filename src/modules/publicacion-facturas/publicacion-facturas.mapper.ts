// src/modules/publicacion-facturas/publicacion-facturas.mapper.ts
import type { Types } from 'mongoose';
import type { PayloadPublicacionLote } from './publicacion-facturas.contrato';

/** The subset of `PublicacionLote` this mapper needs — decoupled from the
 *  Mongoose document/lean type so it stays a pure function of plain data. */
export interface FilaPublicacionLote {
  nit: string;
  loteId: Types.ObjectId | string;
  numerosFactura: string[];
}

/**
 * Pure function building the outbound payload from an outbox row plus a
 * freshly issued signed URL. `numerosFactura` order is preserved verbatim —
 * it is the row's own frozen snapshot of the PDF's page order, and this
 * mapper has no business reordering it.
 */
export function construirPayload(
  fila: FilaPublicacionLote,
  url: string,
  expiresAt: Date,
): PayloadPublicacionLote {
  return {
    nit: fila.nit,
    loteId: fila.loteId.toString(),
    facturas: fila.numerosFactura.map((numeroFactura) => ({ numeroFactura })),
    urlSigned: url,
    urlExpiresAt: expiresAt.toISOString(),
  };
}
