import { reporteDocumentoMultiPagina, renderizarPdf } from './react/document';
import { contenidoRecibo, type DatosReciboImpresion } from './recibo-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Bundles every Recibo of one Recibos-por-lote batch into a single PDF, one
 * receipt per page — same one-`<Document>`-many-`<Page>`s approach as
 * `generarPdfFacturasLote`, built on `contenidoRecibo`.
 */
export async function generarPdfRecibosLote(
  datos: DatosReciboImpresion[],
  copropiedad: CopropiedadDocument,
): Promise<Buffer> {
  const paginas = datos.map((datoRecibo) =>
    contenidoRecibo(datoRecibo, copropiedad),
  );

  return renderizarPdf(reporteDocumentoMultiPagina(paginas));
}
