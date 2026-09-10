import type {
  LoteRecibos as LoteRecibosContract,
  LoteRecibosFila as LoteRecibosFilaContract,
} from '../../contracts';
import type {
  LoteRecibosDocument,
  LoteRecibosFila,
} from '../../database/schemas/recibos/lote-recibos.schema';

const filaDe = (
  fila: LoteRecibosFila,
  numerosPorReciboId: Map<string, string>,
): LoteRecibosFilaContract => ({
  inmuebleCodigo: fila.inmuebleCodigo,
  copropiedadCodigo: fila.copropiedadCodigo,
  inmuebleId: fila.inmuebleId ? fila.inmuebleId.toString() : null,
  fechaPago: fila.fechaPago.toISOString(),
  valorRecibido: fila.valorRecibido,
  reciboId: fila.reciboId ? fila.reciboId.toString() : null,
  reciboNumeroCompleto: fila.reciboId
    ? (numerosPorReciboId.get(fila.reciboId.toString()) ?? null)
    : null,
  error: fila.error,
});

/**
 * Maps a Recibos-por-lote document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish — see "the contract law" in
 * CLAUDE.md, same pattern as `toLote`. `numerosPorReciboId` is the caller's
 * own batch-resolved `reciboId.toString() -> fullNumber` lookup — this
 * module has no Recibo model of its own to resolve it here (mirrors
 * `toReciboDetalle`'s own `numerosPorDocumento` parameter).
 */
export const toLoteRecibos = (
  doc: LoteRecibosDocument,
  numerosPorReciboId: Map<string, string> = new Map(),
): LoteRecibosContract => ({
  id: doc._id.toString(),
  numero: doc.number,
  estado: doc.status,
  codigo: doc.codigo,
  medioPago: doc.medioPago,
  cuentaDestino: doc.cuentaDestino,
  totalDigitado: doc.totalDigitado,
  totalFilas: doc.filas
    .filter((f) => f.error === null)
    .reduce((sum, f) => sum + f.valorRecibido, 0),
  filas: doc.filas.map((f) => filaDe(f, numerosPorReciboId)),
});
