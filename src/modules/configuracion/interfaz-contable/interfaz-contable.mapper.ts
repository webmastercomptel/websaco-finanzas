// src/modules/configuracion/interfaz-contable/interfaz-contable.mapper.ts
import type { MapeoContable } from '../../../contracts';
import type { InterfazContableDocument } from '../../../database/schemas/contabilidad/interfaz-contable.schema';

export const toMapeoContable = (
  doc: InterfazContableDocument,
): MapeoContable => ({
  id: doc._id.toString(),
  tipo: doc.cargoTipo,
  conceptoId: doc.conceptoId?.toString() ?? null,
  conceptoNombre: null,
  especial: doc.cargoEspecial,
  cuentaDebitoId: doc.cuentaDebitoId.toString(),
  cuentaDebitoCodigo: null,
  cuentaCreditoId: doc.cuentaCreditoId.toString(),
  cuentaCreditoCodigo: null,
});
