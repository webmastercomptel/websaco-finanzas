import type { SaldoInicial as SaldoInicialContract } from '../../contracts';
import type { SaldoInicialDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';

/**
 * Maps a Saldo Inicial document to the Spanish API contract — see "the
 * contract law" in CLAUDE.md. `saldoPendiente` is never a field on the
 * document itself (see `SaldoTotalDocumento`'s own docblock on why that
 * balance lives off the document) — the caller resolves it fresh and passes
 * it in here, same pattern `toFactura`/`toNotaDebito` already use.
 */
export const toSaldoInicial = (
  doc: SaldoInicialDocument,
  inmuebleCodigo: string,
  saldoPendiente: number,
): SaldoInicialContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  inmuebleCodigo,
  tipoDocumentoOriginal: doc.tipoDocumentoOriginal,
  numeroOriginal: doc.numeroOriginal,
  fecha: doc.fecha.toISOString(),
  fechaVencimiento: doc.fechaVencimiento.toISOString(),
  lineas: doc.lines.map((linea) => ({
    conceptoId: linea.conceptoId.toString(),
    nombreConcepto: linea.conceptName,
    monto: linea.montoOriginal,
  })),
  total: doc.total,
  saldoPendiente,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
});
