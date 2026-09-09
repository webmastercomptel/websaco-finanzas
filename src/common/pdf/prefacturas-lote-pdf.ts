import { PDFDocument } from 'pdf-lib';
import { generarPdfPrefactura } from './prefactura-pdf';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Bundles every FacturaPreliminar of a lote's previsualización into a single
 * PDF, one prefactura per unit per page — same merge-by-pages approach as
 * `generarPdfFacturasLote`, built on top of `generarPdfPrefactura` unchanged
 * so a full-batch preview always matches what downloading one unit's
 * prefactura at a time already shows.
 */
export async function generarPdfPrefacturasLote(
  previsualizacion: FacturaPreliminar[],
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const combinado = await PDFDocument.create();

  for (const preliminar of previsualizacion) {
    const bytes = await generarPdfPrefactura(preliminar, lote, copropiedad);
    const individual = await PDFDocument.load(bytes);
    const paginas = await combinado.copyPages(
      individual,
      individual.getPageIndices(),
    );
    for (const pagina of paginas) combinado.addPage(pagina);
  }

  return combinado.save();
}
