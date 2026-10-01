// src/modules/configuracion/documentos/documentos.mapper.ts
import type { DocumentoAdmin, ResolucionAdmin } from '../../../contracts';
import type { ConsecutivoDocumentoDocument } from '../../../database/schemas/numeracion/consecutivo-documento.schema';
import type { ResolucionFacturacionDocument } from '../../../database/schemas/numeracion/resolucion-facturacion.schema';

export const toDocumentoAdmin = (
  doc: ConsecutivoDocumentoDocument,
): DocumentoAdmin => ({
  categoria: doc.categoria,
  codigo: doc.codigo,
  nombreDocumento: doc.nombreDocumento,
  prefijo: doc.prefijo,
  numero: doc.siguienteNumero,
  numeroE: doc.numeroElectronico,
  comprob: doc.comprobanteContable,
});

export const toResolucionAdmin = (
  doc: ResolucionFacturacionDocument,
): ResolucionAdmin => ({
  id: doc._id.toString(),
  numeroResolucion: doc.numeroResolucion,
  prefijo: doc.prefijo,
  rangoDesde: doc.rangoDesde,
  rangoHasta: doc.rangoHasta,
  numeroSiguiente: doc.siguienteNumero,
  vigenciaDesde: doc.vigenciaDesde.toISOString(),
  vigenciaHasta: doc.vigenciaHasta?.toISOString() ?? null,
  estado: doc.estado === 'active' ? 'activa' : 'inactiva',
  nombreDocumento: doc.nombreDocumento,
  comprob: doc.comprobanteContable,
  numeroE: doc.numeroElectronico,
});
