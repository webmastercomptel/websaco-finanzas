import { reporteDocumentoMultiPagina, renderizarPdf } from './react/document';
import { paginaFactura } from './factura-pdf.react';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * React-pdf port of `generarPdfFacturasLote` (`facturas-lote-pdf.ts`, kept
 * unchanged and still wired into the controller). Where the pdf-lib version
 * generates each Factura's PDF separately and merges the bytes with
 * `copyPages`, this builds ONE `<Document>` with one `<Page>` per factura up
 * front — react-pdf has no byte-level merge API, so a batch here is a single
 * multi-page tree, not N stitched-together PDFs. Same per-invoice layout
 * either way, since both paths render through `paginaFactura`.
 */
export async function generarPdfFacturasLoteReactPdf(
  facturas: FacturaDocument[],
  resolucionesPorId: Map<string, ResolucionFacturacionDocument>,
  copropiedad: CopropiedadDocument,
): Promise<Buffer> {
  const paginas = facturas.map((factura) => {
    const resolucion = factura.resolucionId
      ? (resolucionesPorId.get(factura.resolucionId.toString()) ?? null)
      : null;
    return paginaFactura(factura, resolucion, copropiedad);
  });

  return renderizarPdf(reporteDocumentoMultiPagina(paginas));
}
