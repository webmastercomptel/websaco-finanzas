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
 */
export const toNotaContable = (
  doc: NotaContableDocument,
): NotaContableContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
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
});
