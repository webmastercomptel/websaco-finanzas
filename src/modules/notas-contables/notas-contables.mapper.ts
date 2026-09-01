import type { NotaContable as NotaContableContract } from '../../contracts';
import type { NotaContableDocument } from '../../database/schemas/notas-contables/nota-contable.schema';

/**
 * Maps a nota contable document to the Spanish API contract. Persistence is
 * English, the API is Spanish, and this is the only place the two meet — see
 * "the contract law" in AGENTS.md, same pattern as `toNotaCredito`.
 */
export const toNotaContable = (
  doc: NotaContableDocument,
): NotaContableContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  conceptoOrigenId: doc.conceptoOrigenId.toString(),
  conceptoDestinoId: doc.conceptoDestinoId.toString(),
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
