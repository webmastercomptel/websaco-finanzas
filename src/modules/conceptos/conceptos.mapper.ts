// src/modules/conceptos/conceptos.mapper.ts
import type { ConceptoCobro as ConceptoContract } from '../../contracts';
import type { ConceptoCobroDocument } from '../../database/schemas/conceptos/concepto-cobro.schema';

/**
 * Maps a billing-concept document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in AGENTS.md.
 */
export const toConcepto = (doc: ConceptoCobroDocument): ConceptoContract => ({
  id: doc._id.toString(),
  copropiedadId: doc.coPropertyId.toString(),
  nombre: doc.name,
  tipo: doc.kind,
  tasaImpuesto: doc.taxRate,
  orden: doc.sortOrder,
  activo: doc.active,
  cuentaContableIngreso: doc.accountingIncomeAccount,
});
