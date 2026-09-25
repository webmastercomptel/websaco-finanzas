import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

/**
 * Whether a document's `estado`/`status` means "voided" — the two
 * vocabularies the six document types actually use, `'emitida' | 'anulada'`
 * (Factura, Nota Débito) and `'activo' | 'anulado'` (Recibo, Nota Crédito,
 * Nota Contable, Nota Anticipo, Saldo Inicial), confirmed against every
 * per-module check already in this codebase. Deliberately NOT gender
 * agreement with the document noun — Nota Crédito is feminine and still uses
 * `'anulado'` — the two vocabularies are just independent historical
 * choices, so this OR is the whole rule, not a stand-in for a smarter one.
 */
export function esAnulado(estado: string): boolean {
  return estado === 'anulada' || estado === 'anulado';
}

/**
 * Stamps "ANULADA"/"ANULADO" diagonally across every page of an
 * already-rendered PDF and returns a DERIVED copy — the input `bytes` (and
 * whatever they came from, `presentacion_documento.objectPath` in Storage)
 * is never touched. `presentacion_documento`'s own docblock establishes that
 * a confirmed document's file is frozen forever, the one that was actually
 * handed to the recipient — a document can be voided AFTER that file was
 * already generated, so the watermark can only ever react to the CURRENT
 * `estado` at read time, never by rewriting the frozen bytes in place. Same
 * "load frozen bytes, derive a copy, persist nothing" shape as
 * `extraerPaginaPdf` in this same folder.
 *
 * Only ever called after `esAnulado(estado)` is true, so the ternary below
 * picking the label is exhaustive in practice — callers gate on `esAnulado`
 * first (see `GeneracionDocumentoService.documentoPdf`).
 */
export async function estamparAnulado(
  bytes: Buffer | Uint8Array,
  estado: string,
): Promise<Uint8Array> {
  const etiqueta = estado === 'anulada' ? 'ANULADA' : 'ANULADO';
  const documento = await PDFDocument.load(bytes);
  const fuente = await documento.embedFont(StandardFonts.HelveticaBold);
  const tamano = 72;
  const ancho = fuente.widthOfTextAtSize(etiqueta, tamano);

  for (const pagina of documento.getPages()) {
    const { width, height } = pagina.getSize();
    pagina.drawText(etiqueta, {
      x: width / 2 - ancho / 2,
      y: height / 2,
      size: tamano,
      font: fuente,
      color: rgb(0.85, 0.1, 0.1),
      opacity: 0.35,
      rotate: degrees(45),
    });
  }

  return documento.save();
}
