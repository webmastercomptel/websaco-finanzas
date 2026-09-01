import type {
  NotaDebito as NotaDebitoContract,
  NotaDebitoDetalle,
} from '../../contracts';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import { toAplicacionCartera } from '../recibos/recibos.mapper';

/**
 * Maps a debit note document to the Spanish API contract. Persistence is
 * English, the API is Spanish, and this is the only place the two meet — see
 * "the contract law" in AGENTS.md, same pattern as `toNotaCredito`.
 */
export const toNotaDebito = (doc: NotaDebitoDocument): NotaDebitoContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  terceroId: doc.terceroId ? doc.terceroId.toString() : null,
  conceptoId: doc.conceptoId.toString(),
  descripcion: doc.description,
  prefijo: doc.prefix,
  numero: doc.number,
  numeroCompleto: doc.fullNumber,
  fechaEmision: doc.issueDate.toISOString(),
  total: doc.total,
  saldoPendiente: doc.outstandingBalance,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
});

/**
 * `toNotaDebito` plus the full applications array — what
 * `GET /notas-debito/:id` returns. `GET /notas-debito` (the listing) keeps
 * using lean `toNotaDebito`, same pattern as `toNotaCreditoDetalle`.
 */
export const toNotaDebitoDetalle = (
  doc: NotaDebitoDocument,
  aplicaciones: AplicacionCarteraDocument[],
): NotaDebitoDetalle => ({
  ...toNotaDebito(doc),
  aplicaciones: aplicaciones.map(toAplicacionCartera),
});
