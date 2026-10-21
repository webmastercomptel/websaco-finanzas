import type { LoteComptable as LoteComptableContract } from '../../contracts';
import type { LoteComptableDocument } from '../../database/schemas/contabilidad/lote-comptable.schema';

const iso = (fecha: Date | null | undefined): string | null =>
  fecha ? fecha.toISOString() : null;

/** `LoteComptable` document → API contract. Type conversion only; never
 *  exposes `asientoIds` (internal) or anything about the payload. */
export const toLoteComptable = (
  doc: LoteComptableDocument,
): LoteComptableContract => ({
  id: doc._id.toString(),
  numero: doc.numero,
  periodoDesde: doc.periodoDesde.toISOString(),
  periodoHasta: doc.periodoHasta.toISOString(),
  totalAsientos: doc.totalAsientos,
  totalLineas: doc.totalLineas,
  totalDebitos: doc.totalDebitos,
  totalCreditos: doc.totalCreditos,
  estado: doc.estado,
  motivoFallo: doc.motivoFallo ?? null,
  comptableLoteId: doc.comptableLoteId ?? null,
  intervenido: Boolean(doc.intervenidoMensaje),
  intervenidoMensaje: doc.intervenidoMensaje ?? null,
  intervenidoEn: iso(doc.intervenidoEn),
  generadoPorNombre: doc.generadoPorNombre,
  fechaGeneracion: doc.createdAt.toISOString(),
  enviadoPorNombre: doc.enviadoPorNombre ?? null,
  enviadoEn: iso(doc.enviadoEn),
  retiradoPorNombre: doc.retiradoPorNombre ?? null,
  retiradoEn: iso(doc.retiradoEn),
});
