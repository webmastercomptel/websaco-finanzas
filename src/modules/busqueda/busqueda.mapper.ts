// src/modules/busqueda/busqueda.mapper.ts
import type { Types } from 'mongoose';
import type {
  ResultadoBusquedaDocumento,
  ResultadoBusquedaInmueble,
  TipoDocumentoBusqueda,
} from '../../contracts';

/**
 * Lean row shapes the service projects. They are declared here (not borrowed
 * from the schemas) because a projection is a deliberately partial document:
 * typing it as the full class would promise fields that were never read.
 */
interface FilaDocumentoBase {
  _id: Types.ObjectId;
  inmuebleId: Types.ObjectId;
  numeroCompleto: string;
  estado: string;
}

export interface FilaFacturaBusqueda extends FilaDocumentoBase {
  codigoInmueble: string;
  titular: { nombre: string } | null;
  fechaEmision: Date;
  total: number;
}

export interface FilaReciboBusqueda extends FilaDocumentoBase {
  fechaRecibo: Date;
  montoRecibido: number;
}

export interface FilaNotaCreditoBusqueda extends FilaDocumentoBase {
  fecha: Date | null;
  createdAt: Date;
  montoTotal: number;
}

export interface FilaNotaDebitoBusqueda extends FilaDocumentoBase {
  fechaEmision: Date;
  total: number;
}

export interface FilaNotaContableBusqueda extends FilaDocumentoBase {
  fecha: Date | null;
  createdAt: Date;
  monto: number;
}

export interface FilaNotaAnticipoBusqueda extends FilaDocumentoBase {
  fechaEmision: Date;
  montoAplicado: number;
}

/** `titularId` as it arrives from `.populate('titularId', 'nombre').lean()`. */
export interface FilaInmuebleBusqueda {
  _id: Types.ObjectId;
  codigo: string;
  titularId: { nombre?: string } | Types.ObjectId | null;
  estado: 'active' | 'inactive';
}

/** What the live Inmueble contributes to a hit, keyed by its id string. */
export interface InmuebleVisible {
  codigo: string;
  titularNombre: string | null;
}
export type InmueblesVisiblesPorId = ReadonlyMap<string, InmuebleVisible>;

/**
 * Reads the holder's name off a `titularId` that may be populated, a bare
 * ObjectId (not populated) or null. A bare ObjectId has no `nombre` key, so
 * the shape check alone tells them apart without importing mongoose at runtime.
 */
export const titularNombreDe = (
  titularId: FilaInmuebleBusqueda['titularId'],
): string | null => {
  if (!titularId || typeof titularId !== 'object') return null;
  if (!('nombre' in titularId)) return null;
  return titularId.nombre ?? null;
};

/** Projects a populated, lean Inmueble onto what hits need from it. */
export const toInmuebleVisible = (
  fila: FilaInmuebleBusqueda,
): InmuebleVisible => ({
  codigo: fila.codigo,
  titularNombre: titularNombreDe(fila.titularId),
});

/**
 * Shared tail of every document hit. A hit whose unit is missing from the
 * lookup (it should not happen — documents point at units of the same
 * coproperty) degrades to an empty code and no holder instead of throwing:
 * a search dropdown must not 500 over one dangling reference.
 */
const documento = (
  tipo: TipoDocumentoBusqueda,
  fila: FilaDocumentoBase,
  fecha: Date,
  monto: number,
  inmueble: InmuebleVisible | undefined,
): ResultadoBusquedaDocumento => ({
  id: fila._id.toString(),
  tipo,
  numeroCompleto: fila.numeroCompleto,
  fecha: fecha.toISOString(),
  inmuebleId: fila.inmuebleId.toString(),
  inmuebleCodigo: inmueble?.codigo ?? '',
  titularNombre: inmueble?.titularNombre ?? null,
  monto,
  estado: fila.estado,
});

/**
 * A Factura prints what was FROZEN when it was issued — unit code and holder —
 * not the unit's current data, exactly like `toFactura`. Searching "who was
 * billed" must answer what the invoice itself says.
 */
export const toResultadoFactura = (
  fila: FilaFacturaBusqueda,
): ResultadoBusquedaDocumento => ({
  ...documento('FV', fila, fila.fechaEmision, fila.total, undefined),
  inmuebleCodigo: fila.codigoInmueble,
  titularNombre: fila.titular?.nombre ?? null,
});

/** Recibo: its `fechaRecibo`, and what was actually received as the amount. */
export const toResultadoRecibo = (
  fila: FilaReciboBusqueda,
  inmuebles: InmueblesVisiblesPorId,
): ResultadoBusquedaDocumento =>
  documento(
    'RC',
    fila,
    fila.fechaRecibo,
    fila.montoRecibido,
    inmuebles.get(fila.inmuebleId.toString()),
  );

/** `fecha` is optional on Notas Crédito/Contables; `createdAt` is the fallback the lists use. */
export const toResultadoNotaCredito = (
  fila: FilaNotaCreditoBusqueda,
  inmuebles: InmueblesVisiblesPorId,
): ResultadoBusquedaDocumento =>
  documento(
    'NC',
    fila,
    fila.fecha ?? fila.createdAt,
    fila.montoTotal,
    inmuebles.get(fila.inmuebleId.toString()),
  );

export const toResultadoNotaDebito = (
  fila: FilaNotaDebitoBusqueda,
  inmuebles: InmueblesVisiblesPorId,
): ResultadoBusquedaDocumento =>
  documento(
    'ND',
    fila,
    fila.fechaEmision,
    fila.total,
    inmuebles.get(fila.inmuebleId.toString()),
  );

export const toResultadoNotaContable = (
  fila: FilaNotaContableBusqueda,
  inmuebles: InmueblesVisiblesPorId,
): ResultadoBusquedaDocumento =>
  documento(
    'NT',
    fila,
    fila.fecha ?? fila.createdAt,
    fila.monto,
    inmuebles.get(fila.inmuebleId.toString()),
  );

export const toResultadoNotaAnticipo = (
  fila: FilaNotaAnticipoBusqueda,
  inmuebles: InmueblesVisiblesPorId,
): ResultadoBusquedaDocumento =>
  documento(
    'NA',
    fila,
    fila.fechaEmision,
    fila.montoAplicado,
    inmuebles.get(fila.inmuebleId.toString()),
  );

/**
 * Inmueble hit. The schema stores `'active'|'inactive'` (English enum values
 * are an established exception) while the contract is Spanish — converted
 * here like `toInmueble` does.
 */
export const toResultadoInmueble = (
  fila: FilaInmuebleBusqueda,
): ResultadoBusquedaInmueble => ({
  id: fila._id.toString(),
  codigo: fila.codigo,
  titularNombre: titularNombreDe(fila.titularId),
  estado: fila.estado === 'active' ? 'activo' : 'inactivo',
});
