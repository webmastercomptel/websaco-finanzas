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
 *
 * `montoAplicado`/`montoSinAplicar` are no longer fields on the (now
 * immutable) document — `Recibo.appliedAmount`/`unappliedAmount` are gone
 * precisely so a Recibo never changes after issuance (see
 * `SaldoDocumentoOrigen`'s own docblock). The caller resolves them (batch-read
 * from that live ledger) and passes them in here, same pattern `toFactura`
 * already uses for its own `saldoPendiente`.
 *
 * `montoOtrosIngresos`, unlike those two, IS read straight off the document
 * — it's frozen at creation (`Recibo.otherIncomeAmount`), never recomputed.
 *
 * `objectPath`/`generatedAt` are resolved by the caller from the shared,
 * permanent `presentacion_documento` table (see that schema's own docblock:
 * a frozen record, not a regenerable cache) — same pattern `toFactura` uses
 * for its own fields of the same name. Defaults to `null` so every call site
 * that has nothing to resolve yet (`crear()`'s own immediate return,
 * `anular()`, listing) doesn't need to pass it explicitly.
 */
export const toRecibo = (
  doc: ReciboDocument,
  montoAplicado: number,
  montoSinAplicar: number,
  // Live-resolved by the caller from `inmuebleId` — no frozen field for it
  // exists on this document, same reasoning as `NotaCredito.inmuebleCodigo`.
  inmuebleCodigo: string,
  presentacion: { objectPath: string; generatedAt: Date } | null = null,
): ReciboContract => ({
  id: doc._id.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  inmuebleCodigo,
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
  montoAplicado,
  montoSinAplicar,
  montoOtrosIngresos: doc.otherIncomeAmount ?? 0,
  estado: doc.status,
  motivoAnulacion: doc.voidedReason,
  detalleAnulacion: doc.voidedDetail,
  fechaAnulacion: doc.voidedAt ? doc.voidedAt.toISOString() : null,
  objectPath: presentacion?.objectPath ?? null,
  generatedAt: presentacion ? presentacion.generatedAt.toISOString() : null,
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
 *
 * `fecha` is a third, REQUIRED parameter — deliberately never `doc.appliedAt`
 * (always the real server instant the cruce ran, needed for the accounting
 * entry, but not what a person means by "the date of this movement"). The
 * caller supplies the SOURCE document's own business date instead — a
 * Recibo's `receivedDate`, a Nota Crédito's `createdAt` (its closest
 * equivalent — see its own schema comment), a Nota de Anticipo's
 * `issueDate`. No default: a call site that forgets this parameter should
 * fail to compile, not silently reintroduce the appliedAt bug.
 */
export const toAplicacionCartera = (
  doc: AplicacionCarteraDocument,
  numeroDocumento: string | null,
  fecha: Date,
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
  fecha: fecha.toISOString(),
});

/**
 * `toRecibo` plus the full applications array — what `GET /recibos/:id`
 * returns so the Confirmación y Cruce screen can render its history.
 * `GET /recibos` (the listing) keeps using lean `toRecibo`.
 *
 * `numerosPorDocumento` is the caller's own batch-resolved
 * `documentId.toString() -> fullNumber` lookup (a Factura or Nota Débito) —
 * this module has no Factura/NotaDebito model of its own to resolve it here.
 *
 * `presentacion` forwards straight to `toRecibo` — see that function's own
 * docblock.
 */
export const toReciboDetalle = (
  doc: ReciboDocument,
  montoAplicado: number,
  montoSinAplicar: number,
  aplicaciones: AplicacionCarteraDocument[],
  inmuebleCodigo: string,
  numerosPorDocumento: Map<string, string> = new Map(),
  presentacion: { objectPath: string; generatedAt: Date } | null = null,
): ReciboDetalle => ({
  ...toRecibo(
    doc,
    montoAplicado,
    montoSinAplicar,
    inmuebleCodigo,
    presentacion,
  ),
  // Self-sourced: every `aplicacion` here was made BY this Recibo, so its
  // own `receivedDate` — never `appliedAt` — is what a person means by "the
  // date of this movement".
  aplicaciones: aplicaciones.map((a) =>
    toAplicacionCartera(
      a,
      numerosPorDocumento.get(a.documentId.toString()) ?? null,
      doc.receivedDate,
    ),
  ),
});
