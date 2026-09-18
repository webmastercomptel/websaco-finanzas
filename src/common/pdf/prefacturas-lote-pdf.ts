import { reporteDocumentoMultiPagina, renderizarPdf } from './react/document';
import { paginaPrefactura } from './prefactura-pdf';
import type { DatosVisualesFactura } from './factura-pdf';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Bundles every FacturaPreliminar of a lote's previsualización into a single
 * PDF, one prefactura per unit per page — same one-`<Document>`-many-`<Page>`s
 * approach as `generarPdfFacturasLote`, built on `paginaPrefactura`.
 */
export async function generarPdfPrefacturasLote(
  previsualizacion: FacturaPreliminar[],
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
  datosVisualesPorInmueble?: Map<string, DatosVisualesFactura>,
): Promise<Buffer> {
  const paginas = previsualizacion.map((preliminar) =>
    paginaPrefactura(
      preliminar,
      lote,
      copropiedad,
      datosVisualesPorInmueble?.get(preliminar.inmuebleId.toString()),
    ),
  );

  return renderizarPdf(reporteDocumentoMultiPagina(paginas));
}
