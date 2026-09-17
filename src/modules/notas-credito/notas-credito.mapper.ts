import type { Types } from 'mongoose';
import type {
  NotaCredito as NotaCreditoContract,
  NotaCreditoDetalle,
} from '../../contracts';
import type { NotaCreditoDocument } from '../../database/schemas/notas-credito/nota-credito.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import { toAplicacionCartera } from '../recibos/recibos.mapper';

/** Which of `facturaId`/`notaDebitoId` is a note's real anchor — `null`
 *  only for documents predating `tipoDocumentoAncla`, all of them
 *  FV-anchored by construction back then (see the schema's own docblock).
 *  Every reader of "what kind of document does this note correct" — this
 *  mapper, `NotasCreditoService`, the PDF — must go through this, never
 *  read `tipoDocumentoAncla` directly. */
export const tipoAnclaDe = (doc: {
  tipoDocumentoAncla: 'FV' | 'ND' | 'SI' | null;
}): 'FV' | 'ND' | 'SI' => doc.tipoDocumentoAncla ?? 'FV';

/** The anchor document's own id, picked from whichever of
 *  `facturaId`/`notaDebitoId`/`saldoInicialId` `tipoAnclaDe` says is real —
 *  see that function's own docblock. */
export const idAnclaDe = (doc: {
  tipoDocumentoAncla: 'FV' | 'ND' | 'SI' | null;
  facturaId: Types.ObjectId | null;
  notaDebitoId: Types.ObjectId | null;
  saldoInicialId: Types.ObjectId | null;
}): Types.ObjectId => {
  const tipo = tipoAnclaDe(doc);
  if (tipo === 'FV') return doc.facturaId!;
  if (tipo === 'ND') return doc.notaDebitoId!;
  return doc.saldoInicialId!;
};

/**
 * The note's own business date — `issueDate` when this document was created
 * with one (every note going forward), falling back to the Mongoose
 * `createdAt` timestamp for a note created before that field existed. Every
 * reader of "the date of this Nota Crédito" — the mapper, the PDF, the
 * estado de cuenta / auxiliar de cartera reports, a Nota Débito paid off by
 * one — must go through this, never read `createdAt` directly, or a
 * backdated `issueDate` (deliberately different from "now") would silently
 * be ignored in some places and honored in others.
 */
export const fechaNotaCredito = (doc: {
  issueDate: Date | null;
  createdAt?: Date;
}): Date => doc.issueDate ?? (doc as unknown as { createdAt: Date }).createdAt;

/**
 * Maps a credit note document to the Spanish API contract. Persistence is
 * English, the API is Spanish, and this is the only place the two meet — see
 * "the contract law" in CLAUDE.md, same pattern as `toRecibo`.
 *
 * `montoAplicado`/`montoSinAplicar` are no longer fields on the (now
 * immutable) document — `NotaCredito.appliedAmount`/`unappliedAmount` are
 * gone precisely so a Nota Crédito never changes after issuance (see
 * `SaldoDocumentoOrigen`'s own docblock). The caller resolves them and
 * passes them in here, same pattern `toRecibo` already uses.
 */
export const toNotaCredito = (
  doc: NotaCreditoDocument,
  montoAplicado: number,
  montoSinAplicar: number,
  // The anchor document's own printed number ("FV-1"/"ND-1") — this
  // document only stores its id. Optional: the lean listing (`findAll`)
  // has no reason to pay for this lookup on every row, only `findOne`'s
  // detail view (via `toNotaCreditoDetalle`) resolves and passes it.
  numeroDocumentoAncla: string | null = null,
): NotaCreditoContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  terceroId: doc.terceroId ? doc.terceroId.toString() : null,
  tipoDocumentoAncla: tipoAnclaDe(doc),
  documentoAnclaId: idAnclaDe(doc).toString(),
  numeroDocumentoAncla,
  prefijo: doc.prefix,
  numero: doc.number,
  numeroCompleto: doc.fullNumber,
  fecha: fechaNotaCredito(doc).toISOString(),
  motivo: doc.reason,
  montoTotal: doc.totalAmount,
  distribucion: doc.distribution.map((linea) => ({
    conceptoId: linea.conceptoId.toString(),
    monto: linea.amount,
  })),
  montoAplicado,
  montoSinAplicar,
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
 *
 * `numerosPorDocumento` is the caller's own batch-resolved
 * `documentId.toString() -> fullNumber` lookup — this module has no Factura/
 * NotaDebito model of its own to resolve it here (same reasoning as
 * `toReciboDetalle`'s identical parameter). The anchor can now be either a
 * Factura or a Nota Débito (see `tipoAnclaDe`); every OTHER `aplicacion`
 * still only ever targets a Factura (`documentType: 'FV'`) — `aplicarManual`/
 * `aplicarFifo` (the deferred-leftover path) can spend a later application
 * against any open Factura of the inmueble, exactly like a Recibo's
 * anticipo, but never against a Nota Débito today.
 */
export const toNotaCreditoDetalle = (
  doc: NotaCreditoDocument,
  montoAplicado: number,
  montoSinAplicar: number,
  aplicaciones: AplicacionCarteraDocument[],
  numerosPorDocumento: Map<string, string> = new Map(),
): NotaCreditoDetalle => ({
  ...toNotaCredito(
    doc,
    montoAplicado,
    montoSinAplicar,
    numerosPorDocumento.get(idAnclaDe(doc).toString()) ?? null,
  ),
  // Self-sourced: every `aplicacion` here was made BY this Nota Crédito, so
  // its own date — never `appliedAt`, the real cruce instant — is what a
  // person means by "the date of this movement".
  aplicaciones: aplicaciones.map((a) =>
    toAplicacionCartera(
      a,
      numerosPorDocumento.get(a.documentId.toString()) ?? null,
      fechaNotaCredito(doc),
    ),
  ),
});
