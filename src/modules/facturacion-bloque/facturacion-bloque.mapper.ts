// src/modules/facturacion-bloque/facturacion-bloque.mapper.ts
import type {
  BloqueFacturacion as BloqueContrato,
  EntregaBloque,
  MiDocumentoBloque,
  UnidadBloqueFacturacion,
} from '../../contracts';
import type { BloqueFacturacionDocument } from '../../database/schemas/administracion/bloque-facturacion.schema';
import type { DocumentoBloqueDocument } from '../../database/schemas/administracion/documento-bloque.schema';
import type { RolBloque } from './facturacion-bloque-acceso';

/**
 * Staff view of a block. Persisted values equal the contract values, so this is
 * type conversion (ObjectId/Date -> string) and nothing else. The lease tokens
 * and the Storage path stay inside: the former are internal bookkeeping, the
 * latter is the backend's to choose.
 */
export function toBloque(
  doc: BloqueFacturacionDocument,
  entrega?: EntregaBloque,
): BloqueContrato {
  return {
    id: doc._id.toString(),
    tipo: doc.tipo,
    periodo: doc.periodo,
    nombre: doc.nombre,
    estado: doc.estado,
    tamanoBytes: doc.tamanoBytes,
    totalPaginas: doc.totalPaginas,
    totalUnidades: doc.totalUnidades,
    paginasSinMatch: [...(doc.paginasSinMatch ?? [])],
    unidadesNoRegistradas: (doc.unidadesNoRegistradas ?? []).map((u) => ({
      codigo: u.codigo,
      paginas: [...u.paginas],
    })),
    unidadesSinDestinatario: doc.unidadesSinDestinatario
      ? [...doc.unidadesSinDestinatario]
      : null,
    motivoError: doc.motivoError ?? null,
    subidoPor: doc.subidoPorNombre ?? '',
    enviadoPor: doc.enviadoEn ? doc.enviadoPorNombre || null : null,
    enviadoEn: doc.enviadoEn ? doc.enviadoEn.toISOString() : null,
    ...(entrega && { entrega }),
    creadoEn: doc.createdAt.toISOString(),
  };
}

/** Staff row of one unit's document. */
export function toUnidadBloque(
  doc: DocumentoBloqueDocument,
): UnidadBloqueFacturacion {
  return {
    id: doc._id.toString(),
    inmuebleId: doc.inmuebleId.toString(),
    codigoInmueble: doc.codigoInmueble,
    paginas: [...doc.paginas],
    tamanoBytes: doc.tamanoBytes,
  };
}

/**
 * A resident's view of one document. Only a `factura` or `estado_cuenta` can get
 * here (the service filters by role first); the storage path never leaves, the
 * download goes through a signed URL minted per request.
 */
export function toMiDocumento(
  doc: DocumentoBloqueDocument,
  rol: RolBloque,
  fecha: Date,
): MiDocumentoBloque {
  return {
    id: doc._id.toString(),
    tipo: doc.tipo as MiDocumentoBloque['tipo'],
    periodo: doc.periodo,
    inmuebleId: doc.inmuebleId.toString(),
    codigoInmueble: doc.codigoInmueble,
    rol,
    cantidadPaginas: doc.paginas.length,
    tamanoBytes: doc.tamanoBytes,
    fecha: fecha.toISOString(),
  };
}
