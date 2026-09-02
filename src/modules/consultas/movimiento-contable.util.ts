import type { Types } from 'mongoose';
import type { AsientoContableDocument } from '../../database/schemas/facturacion/asiento-contable.schema';
import type { MovimientoContable } from '../../contracts';

/**
 * Derive `tipoDocumento` from whichever anchor field is non-null on the
 * AsientoContable. A `loteId`+`facturaId` pair means FC; the other three
 * are single-field discriminators.
 */
export function deriveTipoDocumento(
  asiento: Pick<AsientoContableDocument, 'facturaId' | 'reciboId' | 'notaCreditoId' | 'notaDebitoId' | 'notaContableId'>,
): 'FC' | 'RC' | 'NC' | 'ND' | 'NT' {
  if (asiento.facturaId) return 'FC';
  if (asiento.reciboId) return 'RC';
  if (asiento.notaCreditoId) return 'NC';
  if (asiento.notaDebitoId) return 'ND';
  if (asiento.notaContableId) return 'NT';
  // Should never happen — every asiento has exactly one anchor.
  return 'FC';
}

/**
 * Resolve the anchor document's `_id` from whichever anchor field is set.
 */
export function resolveAnchorId(
  asiento: Pick<AsientoContableDocument, 'facturaId' | 'reciboId' | 'notaCreditoId' | 'notaDebitoId' | 'notaContableId'>,
): Types.ObjectId {
  if (asiento.facturaId) return asiento.facturaId;
  if (asiento.reciboId) return asiento.reciboId;
  if (asiento.notaCreditoId) return asiento.notaCreditoId;
  if (asiento.notaDebitoId) return asiento.notaDebitoId;
  if (asiento.notaContableId) return asiento.notaContableId;
  throw new Error('AsientoContable has no anchor document');
}

/**
 * Build a MovimientoContable from a raw AsientoContable document and its
 * already-resolved anchor metadata.
 *
 * This is a pure function — no database access, no tenant resolution.
 */
export function resolverMovimientoContable(
  asiento: AsientoContableDocument,
  meta: {
    inmuebleCodigo: string | null;
    propietario: string | null;
    nit: string | null;
    numeroDocumento: string;
  },
): MovimientoContable {
  const tipoDocumento = deriveTipoDocumento(asiento);
  const documentoId = resolveAnchorId(asiento).toString();

  const lineas = asiento.entries.map((e) => ({
    cuenta: e.account,
    tipo: e.type,
    monto: e.amount,
    descripcion: e.description,
  }));

  const totalDebito = asiento.entries
    .filter((e) => e.type === 'debito')
    .reduce((sum, e) => sum + e.amount, 0);

  const totalCredito = asiento.entries
    .filter((e) => e.type === 'credito')
    .reduce((sum, e) => sum + e.amount, 0);

  return {
    id: asiento._id.toString(),
    fecha: asiento.date.toISOString(),
    tipoDocumento,
    documentoId,
    numeroDocumento: meta.numeroDocumento,
    inmuebleCodigo: meta.inmuebleCodigo,
    propietario: meta.propietario,
    nit: meta.nit,
    lineas,
    totalDebito,
    totalCredito,
    cuadra: totalDebito === totalCredito,
  };
}
