import { PDFDocument } from 'pdf-lib';
import { FacturasController } from './facturas.controller';
import { extraerPaginaPdf } from '../../common/documentos/extraer-pagina-pdf.util';

function makeController(
  facturas: Record<string, unknown>,
  presentacionDocumento: Record<string, unknown> = {},
  storage: Record<string, unknown> = {},
) {
  return new FacturasController(
    facturas as never,
    {} as never,
    {} as never,
    {} as never,
    presentacionDocumento as never,
    storage as never,
  );
}

async function pdfDeVariasPaginas(cantidad: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < cantidad; i += 1) {
    doc.addPage([400, 600]);
  }
  return Buffer.from(await doc.save());
}

function makeDeps(estado: string, bytesCombinado: Buffer) {
  const factura = {
    printSnapshot: {},
    paginaEnLote: 1,
    loteId: 'lote-1',
    status: estado,
  };
  const facturas = { findOneRaw: jest.fn(() => Promise.resolve(factura)) };
  const presentacionDocumento = {
    buscar: jest.fn(() =>
      Promise.resolve({ objectPath: 'documentos-generados/x/FV/1.pdf' }),
    ),
  };
  const storage = {
    descargarBytes: jest.fn(() => Promise.resolve(bytesCombinado)),
  };
  return { facturas, presentacionDocumento, storage };
}

describe('FacturasController.obtenerDocumentoPdf', () => {
  it('estampa "ANULADA" cuando la factura está anulada — los bytes enviados ya no coinciden con la página sin estampar', async () => {
    const bytesCombinado = await pdfDeVariasPaginas(2);
    const paginaSinEstampar = await extraerPaginaPdf(bytesCombinado, 1);
    const { facturas, presentacionDocumento, storage } = makeDeps(
      'anulada',
      bytesCombinado,
    );
    const controller = makeController(facturas, presentacionDocumento, storage);
    const res = { set: jest.fn(), send: jest.fn() };

    await controller.obtenerDocumentoPdf('fv-1', res as never);

    const bytesEnviados = res.send.mock.calls[0][0] as Buffer;
    expect(
      Buffer.compare(bytesEnviados, Buffer.from(paginaSinEstampar)),
    ).not.toBe(0);
    const resultado = await PDFDocument.load(bytesEnviados);
    expect(resultado.getPageCount()).toBe(1);
  });

  it('no estampa nada cuando la factura sigue emitida — envía exactamente la página extraída', async () => {
    const bytesCombinado = await pdfDeVariasPaginas(2);
    const paginaSinEstampar = await extraerPaginaPdf(bytesCombinado, 1);
    const { facturas, presentacionDocumento, storage } = makeDeps(
      'emitida',
      bytesCombinado,
    );
    const controller = makeController(facturas, presentacionDocumento, storage);
    const res = { set: jest.fn(), send: jest.fn() };

    await controller.obtenerDocumentoPdf('fv-1', res as never);

    const bytesEnviados = res.send.mock.calls[0][0] as Buffer;
    expect(Buffer.compare(bytesEnviados, Buffer.from(paginaSinEstampar))).toBe(
      0,
    );
  });
});
