import type { SaldoInicialAnticipo as SaldoInicialAnticipoContract } from '../../contracts';
import type { SaldoInicialAnticipoDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial-anticipo.schema';

/**
 * Maps a Saldo Inicial de Anticipo document to the Spanish API contract —
 * see "the contract law" in CLAUDE.md. `saldoDisponible` is never a field on
 * the document itself (it lives in `SaldoDocumentoOrigen`, same reasoning as
 * `SaldoInicial.saldoPendiente`/`SaldoTotalDocumento`) — the caller resolves
 * it fresh and passes it in, same pattern `toSaldoInicial` already uses.
 */
export const toSaldoInicialAnticipo = (
  doc: SaldoInicialAnticipoDocument,
  inmuebleCodigo: string,
  saldoDisponible: number,
): SaldoInicialAnticipoContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  inmuebleCodigo,
  tipoDocumentoOriginal: doc.tipoDocumentoOriginal,
  numeroOriginal: doc.numeroOriginal,
  fecha: doc.receivedDate.toISOString(),
  monto: doc.montoOriginal,
  saldoDisponible,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
});
