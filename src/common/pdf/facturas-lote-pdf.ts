import {
  reporteDocumentoMultiPagina,
  renderizarPdfStream,
} from './react/document';
import { paginaFactura } from './factura-pdf';
import type { FacturaLean } from '../../modules/facturacion/facturas.service';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Bundles every Factura of one lote into a single PDF, one invoice per page.
 *
 * Builds ONE `<Document>` with one `<Page>` per factura up front, reusing
 * `paginaFactura` (`factura-pdf.ts`) for each invoice's own content — react-pdf
 * has no byte-level merge API, so a batch here is a single multi-page tree,
 * not N stitched-together PDFs (pdf-lib's old approach via `copyPages`). Same
 * per-invoice layout either way, since both the single "Descargar PDF"
 * download and this batch render through `paginaFactura`, so a printed batch
 * always matches what downloading one factura at a time would show, page for
 * page. React-pdf, built directly (no pdf-lib version kept behind a
 * `?version=` toggle — direct cutover, same as the rest of this migration).
 *
 * Takes `FacturaLean[]` (from `FacturasService.findAllRawPorLote`'s `.lean()`
 * query) rather than hydrated documents, and streams the render
 * (`renderizarPdfStream`) instead of buffering it — a lote can run into the
 * hundreds of invoices, and neither hydrating every one nor holding the whole
 * rendered PDF in memory at once is safe under Cloud Run's memory ceiling.
 */
export async function generarPdfFacturasLote(
  facturas: FacturaLean[],
  resolucionesPorId: Map<string, ResolucionFacturacionDocument>,
  copropiedad: CopropiedadDocument,
): Promise<NodeJS.ReadableStream> {
  const paginas = facturas.map((factura) => {
    const resolucion = factura.resolucionId
      ? (resolucionesPorId.get(factura.resolucionId.toString()) ?? null)
      : null;
    return paginaFactura(factura, resolucion, copropiedad);
  });

  return renderizarPdfStream(reporteDocumentoMultiPagina(paginas));
}
