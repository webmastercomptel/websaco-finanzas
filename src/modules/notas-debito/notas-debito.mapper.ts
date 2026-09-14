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
 * "the contract law" in CLAUDE.md, same pattern as `toNotaCredito`.
 */
export const toNotaDebito = (
  doc: NotaDebitoDocument,
  saldoPendiente: number,
): NotaDebitoContract => ({
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
  saldoPendiente,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
});

/**
 * `toNotaDebito` plus the full applications array — what
 * `GET /notas-debito/:id` returns. `GET /notas-debito` (the listing) keeps
 * using lean `toNotaDebito`, same pattern as `toNotaCreditoDetalle`.
 *
 * Unlike `toReciboDetalle`/`toNotaCreditoDetalle`/`toNotaAnticipoDetalle`
 * (self-sourced: every `aplicacion.sourceId` IS `doc._id`, the document
 * being viewed), a Nota Débito's own `aplicaciones` are "who paid ME" — each
 * one's source can be a DIFFERENT Recibo/Nota Crédito/Nota de Anticipo, each
 * with its own business date. `fechasPorSourceId` is the caller's own
 * batch-resolved `sourceId.toString() -> fecha` lookup across all three
 * source collections (this module has no direct query of its own for them).
 */
export const toNotaDebitoDetalle = (
  doc: NotaDebitoDocument,
  saldoPendiente: number,
  aplicaciones: AplicacionCarteraDocument[],
  fechasPorSourceId: Map<string, Date> = new Map(),
): NotaDebitoDetalle => ({
  ...toNotaDebito(doc, saldoPendiente),
  aplicaciones: aplicaciones.map((a) =>
    toAplicacionCartera(
      a,
      null,
      fechasPorSourceId.get(a.sourceId.toString()) ?? a.appliedAt,
    ),
  ),
});
