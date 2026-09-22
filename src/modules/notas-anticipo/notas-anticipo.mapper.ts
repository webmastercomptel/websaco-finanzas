import type {
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
 * `objectPath`/`generatedAt` are resolved by the caller from the shared,
 * permanent `presentacion_documento` table — same pattern `toRecibo`/
 * `toNotaDebito` use for their own fields of the same name. Defaults to
 * `null` so `crear()`'s own immediate return, `anular()`, and the listing
 * don't need to pass it explicitly.
 */
export const toNotaAnticipo = (
  doc: NotaAnticipoDocument,
  // Live-resolved by the caller from `inmuebleId` — no frozen field for it
  // exists on this document, same reasoning as `NotaCredito.inmuebleCodigo`.
  inmuebleCodigo: string,
  presentacion: { objectPath: string; generatedAt: Date } | null = null,
): NotaAnticipoContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  inmuebleCodigo,
  terceroId: doc.terceroId ? doc.terceroId.toString() : null,
  origenTipo: doc.origenTipo,
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
  objectPath: presentacion?.objectPath ?? null,
  generatedAt: presentacion ? presentacion.generatedAt.toISOString() : null,
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
  inmuebleCodigo: string,
  numerosPorDocumento: Map<string, string> = new Map(),
  presentacion: { objectPath: string; generatedAt: Date } | null = null,
): NotaAnticipoDetalle => ({
  ...toNotaAnticipo(doc, inmuebleCodigo, presentacion),
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
