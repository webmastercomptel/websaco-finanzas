import { PDFDocument } from 'pdf-lib';
import { generarPdfFactura } from './factura-pdf';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { LoteFacturacionDocument } from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Bundles every Factura of one lote into a single PDF, one invoice per page.
 *
 * Built by generating each invoice's own PDF with `generarPdfFactura` —
 * unchanged, same function the single "Descargar PDF" download calls — and
 * merging their pages with pdf-lib's `copyPages`, rather than reimplementing
 * the invoice layout here. A printed batch this way always matches what
 * downloading one factura at a time would show, page for page. `lote` is
 * the ONE billing run every one of these facturas came from (this endpoint
 * is always "every factura of lote X"), passed straight through to each
 * `generarPdfFactura` call for its own discount-offer computation.
 */
export async function generarPdfFacturasLote(
  facturas: FacturaDocument[],
  resolucionesPorId: Map<string, ResolucionFacturacionDocument>,
  copropiedad: CopropiedadDocument,
  lote: LoteFacturacionDocument,
): Promise<Uint8Array> {
  const combinado = await PDFDocument.create();

  for (const factura of facturas) {
    const resolucion = factura.resolucionId
      ? (resolucionesPorId.get(factura.resolucionId.toString()) ?? null)
      : null;
    const bytes = await generarPdfFactura(
      factura,
      resolucion,
      copropiedad,
      lote,
    );
    const individual = await PDFDocument.load(bytes);
    const paginas = await combinado.copyPages(
      individual,
      individual.getPageIndices(),
    );
    for (const pagina of paginas) combinado.addPage(pagina);
  }

  return combinado.save();
}
