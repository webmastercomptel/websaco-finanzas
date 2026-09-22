import type { NotaContable as NotaContableContract } from '../../contracts';
import type { NotaContableDocument } from '../../database/schemas/notas-contables/nota-contable.schema';

/**
 * The note's own business date — `issueDate` when this document was created
 * with one (every note going forward), falling back to the Mongoose
 * `createdAt` timestamp for a note created before that field existed. Every
 * reader of "the date of this Nota Contable" must go through this, never
 * read `createdAt` directly — same pattern as `fechaNotaCredito`.
 */
export const fechaNotaContable = (doc: {
  issueDate: Date | null;
  createdAt?: Date;
}): Date => doc.issueDate ?? (doc as unknown as { createdAt: Date }).createdAt;

/**
 * Maps a nota contable document to the Spanish API contract. Persistence is
 * English, the API is Spanish, and this is the only place the two meet — see
 * "the contract law" in CLAUDE.md, same pattern as `toNotaCredito`.
 *
 * `objectPath`/`generatedAt` are resolved by the caller from the shared,
 * permanent `presentacion_documento` table — same pattern `toRecibo`/
 * `toNotaDebito` use for their own fields of the same name. Defaults to
 * `null` so `crear()`'s own immediate return, `anular()`, and the listing
 * don't need to pass it explicitly.
 */
export const toNotaContable = (
  doc: NotaContableDocument,
  // Live-resolved by the caller from `inmuebleId` — no frozen field for it
  // exists on this document, same reasoning as `NotaCredito.inmuebleCodigo`.
  inmuebleCodigo: string,
  presentacion: { objectPath: string; generatedAt: Date } | null = null,
): NotaContableContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  inmuebleCodigo,
  // Nota Contable's `tipoDocumento` shares the generic `DocumentType` enum
  // (now `'FV'|'ND'|'SI'`) with every other cartera document, but nothing
  // creates one anchored on a Saldo Inicial — reclassifying against one is
  // out of scope (see `SaldoInicial`'s own schema docblock) — so that value
  // can never actually occur here; narrowed defensively rather than
  // widening this contract field for a case that can't happen.
  tipoDocumento:
    doc.tipoDocumento === 'SI' ? null : (doc.tipoDocumento ?? null),
  documentoId: doc.documentoId ? doc.documentoId.toString() : null,
  conceptoOrigenId: doc.conceptoOrigenId.toString(),
  conceptoDestinoId: doc.conceptoDestinoId.toString(),
  fecha: fechaNotaContable(doc).toISOString(),
  monto: doc.monto,
  descripcion: doc.description,
  prefijo: doc.prefix,
  numero: doc.number,
  numeroCompleto: doc.fullNumber,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
  objectPath: presentacion?.objectPath ?? null,
  generatedAt: presentacion ? presentacion.generatedAt.toISOString() : null,
});
