import type {
  AplicacionCartera as AplicacionCarteraContract,
  Recibo as ReciboContract,
  ReciboDetalle,
} from '../../contracts';
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';

/**
 * Maps a receipt document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md, same pattern as
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

/**
 * Maps a cruce row to its Spanish contract shape. GENERALIZED (Task 1): the
 * source and target document may be a Recibo or a Nota Crédito, discriminated
 * by `sourceType` — the Notas Crédito mapper reuses this function directly
 * (design §4).
 *
 * `numeroDocumento` is a second, EXPLICIT parameter (never positional-only
 * via a bare `.map(toAplicacionCartera)`, which would leak `Array.map`'s own
 * index into it) — every call site below uses `.map((doc) => ...)` for
 * exactly this reason.
 */
export const toAplicacionCartera = (
  doc: AplicacionCarteraDocument,
  numeroDocumento: string | null = null,
): AplicacionCarteraContract => ({
  id: doc._id.toString(),
  sourceType: doc.sourceType,
  sourceId: doc.sourceId.toString(),
  tipoDocumento: doc.documentType,
  documentoId: doc.documentId.toString(),
  numeroDocumento,
  montoAplicado: doc.amountApplied,
  montoDescuento: doc.discountApplied,
  detalleConceptos: (doc.detalleConceptos ?? []).map((d) => ({
    conceptoId: d.conceptoId.toString(),
    nombreConcepto: d.conceptName,
    monto: d.monto,
  })),
  estado: doc.status,
  fecha: doc.appliedAt.toISOString(),
});

/**
 * `toRecibo` plus the full applications array — what `GET /recibos/:id`
 * returns so the Confirmación y Cruce screen can render its history.
 * `GET /recibos` (the listing) keeps using lean `toRecibo`.
 *
 * `numerosPorDocumento` is the caller's own batch-resolved
 * `documentId.toString() -> fullNumber` lookup (a Factura or Nota Débito) —
 * this module has no Factura/NotaDebito model of its own to resolve it here.
 */
export const toReciboDetalle = (
  doc: ReciboDocument,
  aplicaciones: AplicacionCarteraDocument[],
  numerosPorDocumento: Map<string, string> = new Map(),
): ReciboDetalle => ({
  ...toRecibo(doc),
  aplicaciones: aplicaciones.map((a) =>
    toAplicacionCartera(
      a,
      numerosPorDocumento.get(a.documentId.toString()) ?? null,
    ),
  ),
});
