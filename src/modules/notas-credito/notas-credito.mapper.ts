import type {
  NotaCredito as NotaCreditoContract,
  NotaCreditoDetalle,
} from '../../contracts';
import type { NotaCreditoDocument } from '../../database/schemas/notas-credito/nota-credito.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import { toAplicacionCartera } from '../recibos/recibos.mapper';

/**
 * Maps a credit note document to the Spanish API contract. Persistence is
 * English, the API is Spanish, and this is the only place the two meet — see
 * "the contract law" in AGENTS.md, same pattern as `toRecibo`.
 */
export const toNotaCredito = (
  doc: NotaCreditoDocument,
): NotaCreditoContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  terceroId: doc.terceroId ? doc.terceroId.toString() : null,
  facturaId: doc.facturaId.toString(),
  prefijo: doc.prefix,
  numero: doc.number,
  numeroCompleto: doc.fullNumber,
  motivo: doc.reason,
  montoTotal: doc.totalAmount,
  distribucion: doc.distribution.map((linea) => ({
    conceptoId: linea.conceptoId.toString(),
    monto: linea.amount,
  })),
  montoAplicado: doc.appliedAmount,
  montoSinAplicar: doc.unappliedAmount,
  observaciones: doc.notes,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
});

/**
 * `toNotaCredito` plus the full applications array — what
 * `GET /notas-credito/:id` returns. `GET /notas-credito` (the listing) keeps
 * using lean `toNotaCredito`, same pattern as `toReciboDetalle`. Reuses
 * `toAplicacionCartera` from the Recibos mapper directly (design's
 * generalized `AplicacionCartera` row, cross-module — same precedent as
 * reusing `cruce.util.ts`).
 */
export const toNotaCreditoDetalle = (
  doc: NotaCreditoDocument,
  aplicaciones: AplicacionCarteraDocument[],
): NotaCreditoDetalle => ({
  ...toNotaCredito(doc),
  aplicaciones: aplicaciones.map(toAplicacionCartera),
});
