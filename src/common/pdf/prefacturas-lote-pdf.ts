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
 * PDF, one prefactura per unit per page — one `<Document>` with many
 * `<Page>`s, built on `paginaPrefactura`.
 *
 * Streams the render (`renderizarPdfStream`) rather than buffering it — a
 * lote's full previsualización can run into the hundreds of units, and
 * `renderToBuffer` would hold the whole rendered PDF in memory twice over
 * before returning.
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
