import { PDFDocument } from 'pdf-lib';

/**
 * Extracts ONE page out of an already-rendered, already-uploaded PDF —
 * `pdf-lib` here is pure document manipulation (copying page objects), never
 * a layout/rendering engine, unlike the `@react-pdf/renderer`
 * dependency this codebase deliberately dropped (see `a4c7f07`'s own commit
 * message). Nothing here interprets `docDefinition`/JSX/templates; it only
 * moves already-drawn PDF pages from one document to another.
 *
 * Built for `FacturasController.obtenerDocumentoPdf`: a Factura is
 * batch-only (its lote's invoice run produces one combined PDF, one page
 * per invoice — see `Factura.paginaEnLote`'s own docblock), and re-reading
 * that combined file to show a single invoice would leak every other unit's
 * invoice to whoever is only entitled to see their own. Extracting the one
 * page server-side and returning ONLY those bytes closes that leak without
 * re-rendering (no template-version drift risk — this is literally a slice
 * of the same frozen file the lote's own download already serves) and
 * without persisting a second copy anywhere (extracted fresh on every
 * request; viewing one invoice on its own is a rare, support-driven case,
 * not a path worth trading Storage growth to cache).
 *
 * `numeroPagina` is 1-based (`Factura.paginaEnLote`'s own convention,
 * matching how a person reads "page 3 of 12", not a 0-based array index).
 */
export async function extraerPaginaPdf(
  bytesCombinado: Buffer,
  numeroPagina: number,
): Promise<Uint8Array> {
  const combinado = await PDFDocument.load(bytesCombinado);
  const individual = await PDFDocument.create();
  const [pagina] = await individual.copyPages(combinado, [numeroPagina - 1]);
  individual.addPage(pagina);
  return individual.save();
}
