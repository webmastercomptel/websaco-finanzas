import { PDFDocument } from 'pdf-lib';
import { extraerPaginaPdf } from './extraer-pagina-pdf.util';

/** Builds a real multi-page PDF, one differently-sized page per entry in
 *  `anchos` — a distinguishable size per page (rather than identical blank
 *  pages) is what lets a test actually prove "the RIGHT page came out",
 *  not just "some page came out". */
async function pdfDeVariasPaginas(anchos: number[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const ancho of anchos) {
    doc.addPage([ancho, 400]);
  }
  return Buffer.from(await doc.save());
}

describe('extraerPaginaPdf', () => {
  it('extrae la página pedida (1-based) como un PDF de una sola página', async () => {
    const combinado = await pdfDeVariasPaginas([300, 400, 500]);

    const bytes = await extraerPaginaPdf(combinado, 2);

    const extraido = await PDFDocument.load(bytes);
    expect(extraido.getPageCount()).toBe(1);
    expect(extraido.getPage(0).getWidth()).toBe(400);
  });

  it('extrae la primera página cuando se pide la página 1', async () => {
    const combinado = await pdfDeVariasPaginas([111, 222]);

    const bytes = await extraerPaginaPdf(combinado, 1);

    const extraido = await PDFDocument.load(bytes);
    expect(extraido.getPage(0).getWidth()).toBe(111);
  });

  it('extrae la última página cuando se pide el número de página final', async () => {
    const combinado = await pdfDeVariasPaginas([111, 222, 333]);

    const bytes = await extraerPaginaPdf(combinado, 3);

    const extraido = await PDFDocument.load(bytes);
    expect(extraido.getPage(0).getWidth()).toBe(333);
  });
});
