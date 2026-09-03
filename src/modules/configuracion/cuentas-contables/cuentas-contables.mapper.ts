// src/modules/configuracion/cuentas-contables/cuentas-contables.mapper.ts
import type { CuentaContableContract } from '../../../contracts';
import type { CuentaContableDocument } from '../../../database/schemas/contabilidad/cuenta-contable.schema';

/**
 * Maps a CuentaContable document to the Spanish API contract.
 * Persistence is English, the API is Spanish — the contract law.
 */
export const toCuentaContable = (
  doc: CuentaContableDocument,
): CuentaContableContract => ({
  id: doc._id.toString(),
  codigo: doc.code,
  nombre: doc.name,
  requiereTercero: doc.requiresTercero,
  flujoCaja: doc.cashFlow,
  centroUtilidad: doc.profitCenterCode,
  centroDestino: doc.destinationCenterCode,
  requiereDocumentoCruce: doc.requiresCrossDocument,
  tipoImpuesto: doc.taxType,
  tasaImpuesto: doc.taxRate,
  activo: doc.active,
});
