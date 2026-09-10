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
 */
export const toNotaAnticipo = (
  doc: NotaAnticipoDocument,
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
): NotaAnticipoDetalle => ({
  ...toNotaAnticipo(doc),
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
