import type {
  AplicacionRecibo as AplicacionReciboContract,
  Recibo as ReciboContract,
  ReciboDetalle,
} from '../../contracts';
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { AplicacionReciboDocument } from '../../database/schemas/recibos/aplicacion-recibo.schema';

/**
 * Maps a receipt document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in AGENTS.md, same pattern as
 * `toFactura`/`toLote`.
 */
export const toRecibo = (doc: ReciboDocument): ReciboContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  terceroId: doc.terceroId.toString(),
  prefijo: doc.prefix,
  numero: doc.number,
  numeroCompleto: doc.fullNumber,
  montoRecibido: doc.receivedAmount,
  fechaRecibo: doc.receivedDate.toISOString(),
  medioPago: doc.paymentMethod,
  cuentaDestino: doc.destinationAccount,
  referencia: doc.reference,
  observaciones: doc.notes,
  montoAplicado: doc.appliedAmount,
  montoSinAplicar: doc.unappliedAmount,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
});

export const toAplicacionRecibo = (
  doc: AplicacionReciboDocument,
): AplicacionReciboContract => ({
  id: doc._id.toString(),
  tipoDocumento: doc.documentType,
  documentoId: doc.documentId.toString(),
  montoAplicado: doc.amountApplied,
  estado: doc.status,
  fecha: doc.appliedAt.toISOString(),
});

/**
 * `toRecibo` plus the full applications array — what `GET /recibos/:id`
 * returns so the Confirmación y Cruce screen can render its history.
 * `GET /recibos` (the listing) keeps using lean `toRecibo`.
 */
export const toReciboDetalle = (
  doc: ReciboDocument,
  aplicaciones: AplicacionReciboDocument[],
): ReciboDetalle => ({
  ...toRecibo(doc),
  aplicaciones: aplicaciones.map(toAplicacionRecibo),
});
