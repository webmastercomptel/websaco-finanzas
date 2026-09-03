// src/modules/configuracion/documentos/documentos.mapper.ts
import type { DocumentoAdmin, ResolucionAdmin } from '../../../contracts';
import type { ConsecutivoDocumentoDocument } from '../../../database/schemas/numeracion/consecutivo-documento.schema';
import type { ResolucionFacturacionDocument } from '../../../database/schemas/numeracion/resolucion-facturacion.schema';

export const toDocumentoAdmin = (
  doc: ConsecutivoDocumentoDocument,
): DocumentoAdmin => ({
  tipo: doc.documentType,
  nombreDocumento: doc.displayName,
  prefijo: doc.prefix,
  numero: doc.nextNumber,
  numeroE: doc.electronicNumber,
  comprob: doc.accountingVoucherCode,
});

export const toResolucionAdmin = (
  doc: ResolucionFacturacionDocument,
): ResolucionAdmin => ({
  id: doc._id.toString(),
  numeroResolucion: doc.resolutionNumber,
  prefijo: doc.prefix,
  rangoDesde: doc.rangeFrom,
  rangoHasta: doc.rangeTo,
  numeroSiguiente: doc.nextNumber,
  vigenciaDesde: doc.validFrom.toISOString(),
  vigenciaHasta: doc.validUntil?.toISOString() ?? null,
  estado: doc.status === 'active' ? 'activa' : 'inactiva',
  nombreDocumento: doc.displayName,
  comprob: doc.accountingVoucherCode,
  numeroE: doc.electronicNumber,
});
