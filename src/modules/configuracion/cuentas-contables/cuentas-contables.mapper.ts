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
  codigo: doc.codigo,
  nombre: doc.nombre,
  requiereTercero: doc.requiereTercero,
  esBanco: doc.esBanco,
  flujoCaja: doc.flujoCaja,
  centroUtilidad: doc.centroUtilidad,
  centroDestino: doc.centroDestino,
  requiereDocumentoCruce: doc.requiereDocumentoCruce,
  aplicaImpuesto: doc.aplicaImpuesto,
  tasaImpuesto: doc.tasaImpuesto,
  activo: doc.activo,
});
