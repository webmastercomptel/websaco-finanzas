import { reporteDocumentoMultiPagina, renderizarPdf } from './react/document';
import { paginaPrefactura } from './prefactura-pdf.react';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * React-pdf port of `generarPdfPrefacturasLote` (`prefacturas-lote-pdf.ts`,
 * kept unchanged and still wired into the controller) — same
 * one-`<Document>`-many-`<Page>`s approach as `generarPdfFacturasLoteReactPdf`,
 * built on `paginaPrefactura`.
 */
export async function generarPdfPrefacturasLoteReactPdf(
  previsualizacion: FacturaPreliminar[],
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
): Promise<Buffer> {
  const paginas = previsualizacion.map((preliminar) =>
    paginaPrefactura(preliminar, lote, copropiedad),
  );

  return renderizarPdf(reporteDocumentoMultiPagina(paginas));
}
