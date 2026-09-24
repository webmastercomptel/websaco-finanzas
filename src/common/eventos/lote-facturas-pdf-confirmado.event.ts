// src/common/eventos/lote-facturas-pdf-confirmado.event.ts

/**
 * Emitted by `LotesController.confirmarGeneracionFacturas` right after a
 * `LoteFacturacion`'s combined FV PDF is confirmed as uploaded. Lives in
 * `common/` — NOT inside `modules/publicacion-facturas/` — on purpose: the
 * billing domain (`facturacion`) emits this fact without importing the
 * publisher module. Deleting `modules/publicacion-facturas/` and its import
 * from `app.module.ts` leaves `facturacion` compiling unchanged; with no
 * listener registered, `emitAsync` on this event type simply resolves `[]`.
 */
export const LOTE_FACTURAS_PDF_CONFIRMADO = 'lote-facturas.pdf-confirmado';

export interface LoteFacturasPdfConfirmadoEvent {
  coPropertyId: string;
  loteId: string;
  objectPath: string;
  /**
   * `Factura.fullNumber`, in `findAllRawPorLote` order (unitCode asc) — the
   * same order the invoices were laid out into the combined PDF's pages.
   * This array's order is load-bearing: WebSaco3's splitter maps page `i` to
   * `facturas[i]`. Anuladas are NOT filtered out here, because none were
   * filtered out of the PDF either — this mirrors exactly what was printed.
   */
  numerosFactura: string[];
}
