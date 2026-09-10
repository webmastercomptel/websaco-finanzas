import { PDFDocument } from 'pdf-lib';
import { generarPdfRecibo, type DatosReciboImpresion } from './recibo-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * Bundles every Recibo of one Recibos-por-lote batch into a single PDF, one
 * receipt per page — same "generate each one's own PDF, then merge pages
 * with pdf-lib" approach as `generarPdfFacturasLote`, so a printed batch
 * always matches what downloading one Recibo at a time would show.
 */
export async function generarPdfRecibosLote(
  datos: DatosReciboImpresion[],
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const combinado = await PDFDocument.create();

  for (const datoRecibo of datos) {
    const bytes = await generarPdfRecibo(datoRecibo, copropiedad);
    const individual = await PDFDocument.load(bytes);
    const paginas = await combinado.copyPages(
      individual,
      individual.getPageIndices(),
    );
    for (const pagina of paginas) combinado.addPage(pagina);
  }

  return combinado.save();
}
