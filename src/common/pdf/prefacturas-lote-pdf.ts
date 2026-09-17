import {
  reporteDocumentoMultiPagina,
  renderizarPdfStream,
} from './react/document';
import { paginaPrefactura } from './prefactura-pdf';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Bundles every FacturaPreliminar of a lote's previsualización into a single
 * PDF, one prefactura per unit per page — same one-`<Document>`-many-`<Page>`s
 * approach as `generarPdfFacturasLote`, built on `paginaPrefactura`.
 *
 * Streams the render (`renderizarPdfStream`) rather than buffering it, same
 * reason as `generarPdfFacturasLote` — a lote's full previsualización can run
 * into the hundreds of units.
 */
export async function generarPdfPrefacturasLote(
  previsualizacion: FacturaPreliminar[],
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
): Promise<NodeJS.ReadableStream> {
  const paginas = previsualizacion.map((preliminar) =>
    paginaPrefactura(preliminar, lote, copropiedad),
  );

  return renderizarPdfStream(reporteDocumentoMultiPagina(paginas));
}
