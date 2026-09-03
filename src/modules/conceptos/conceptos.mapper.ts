// src/modules/conceptos/conceptos.mapper.ts
import type { ConceptoCobro as ConceptoContract } from '../../contracts';
import type { ConceptoCobroDocument } from '../../database/schemas/conceptos/concepto-cobro.schema';
import type { CuentaContableDocument } from '../../database/schemas/contabilidad/cuenta-contable.schema';

/**
 * Maps a billing-concept document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in AGENTS.md.
 *
 * After populating cuentaDebitoId and cuentaCreditoId, the mapper extracts
 * their `code` fields for the contract.
 */
export const toConcepto = (
  doc: ConceptoCobroDocument,
): ConceptoContract => ({
  id: doc._id.toString(),
  copropiedadId: doc.coPropertyId.toString(),
  nombre: doc.name,
  tipo: doc.kind,
  tasaImpuesto: doc.taxRate,
  orden: doc.sortOrder,
  cuentaDebitoCodigo:
    (doc.cuentaDebitoId as unknown as CuentaContableDocument)?.code ?? null,
  cuentaCreditoCodigo:
    (doc.cuentaCreditoId as unknown as CuentaContableDocument)?.code ?? null,
  liquidaMora: doc.liquidaMora,
  sistema: doc.isSystem,
});
