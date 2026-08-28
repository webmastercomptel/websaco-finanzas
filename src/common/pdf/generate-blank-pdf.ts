import { PDFDocument } from 'pdf-lib';

/**
 * Creates a blank single-page PDF entirely in memory (no filesystem writes).
 * This is the smoke-tested foundation for future invoice/receipt/credit-note
 * PDF generation — it exists here only to prove pdf-lib works end-to-end with
 * the plain Jest runner. Unlike pdfjs-dist (PDF text extraction, not used in
 * this project), pdf-lib does NOT require `--experimental-vm-modules`.
 */
export async function generateBlankPdf(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage();
  return pdfDoc.save();
}
