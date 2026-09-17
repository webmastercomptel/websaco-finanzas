import type {
  NodoDocumentoFactura,
  NotaAnticipo as NotaAnticipoContract,
  NotaAnticipoDetalle,
} from '../../contracts';
import type { NotaAnticipoDocument } from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import { toAplicacionCartera } from '../recibos/recibos.mapper';

/**
 * Maps a Nota de Anticipo document to the Spanish API contract. Persistence
 * is English, the API is Spanish — see "the contract law" in CLAUDE.md, same
 * pattern as `toNotaDebito`.
 *
 * `documentDefinition` is resolved by the caller from the shared, permanent
 * `presentacion_documento` table — same pattern `toRecibo`/`toNotaDebito`
 * use for their own field of the same name. Defaults to `null` so
 * `crear()`'s own immediate return, `anular()`, and the listing don't need
 * to pass it explicitly.
 */
export const toNotaAnticipo = (
  doc: NotaAnticipoDocument,
  documentDefinition: Record<string, unknown> | null = null,
): NotaAnticipoContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  terceroId: doc.terceroId ? doc.terceroId.toString() : null,
  reciboOrigenId: doc.reciboOrigenId.toString(),
  prefijo: doc.prefix,
  numero: doc.number,
  numeroCompleto: doc.fullNumber,
  fechaEmision: doc.issueDate.toISOString(),
  montoAplicado: doc.appliedAmount,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
  // Opaque blob, passed through unchanged — same cast `toFactura` uses for
  // its own field of the same name.
  documentDefinition: documentDefinition as NodoDocumentoFactura | null,
});

/**
 * `toNotaAnticipo` plus the cargo-por-cargo breakdown of what it applied —
 * what `GET /notas-anticipo/:id` returns, same pattern as
 * `toNotaDebitoDetalle`. `numeroDocumento` per application is resolved by
 * the caller, same reasoning as `toReciboDetalle`.
 */
export const toNotaAnticipoDetalle = (
  doc: NotaAnticipoDocument,
  aplicaciones: AplicacionCarteraDocument[],
  numerosPorDocumento: Map<string, string> = new Map(),
  documentDefinition: Record<string, unknown> | null = null,
): NotaAnticipoDetalle => ({
  ...toNotaAnticipo(doc, documentDefinition),
  // Self-sourced: every `aplicacion` here was made BY this Nota de
  // Anticipo, so its own `issueDate` — never `appliedAt` — is what a person
  // means by "the date of this movement".
  aplicaciones: aplicaciones.map((a) =>
    toAplicacionCartera(
      a,
      numerosPorDocumento.get(a.documentId.toString()) ?? null,
      doc.issueDate,
    ),
  ),
});
