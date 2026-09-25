import { PDFDocument } from 'pdf-lib';
import { esAnulado, estamparAnulado } from './estampar-anulado.util';

async function pdfDeVariasPaginas(cantidad: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < cantidad; i += 1) {
    doc.addPage([400, 600]);
  }
  return Buffer.from(await doc.save());
}

describe('esAnulado', () => {
  it('es true para el estado "anulada"', () => {
    expect(esAnulado('anulada')).toBe(true);
  });

  it('es true para el estado "anulado"', () => {
    expect(esAnulado('anulado')).toBe(true);
  });

  it('es false para "emitida"', () => {
    expect(esAnulado('emitida')).toBe(false);
  });

  it('es false para "activo"', () => {
    expect(esAnulado('activo')).toBe(false);
  });
});

describe('estamparAnulado', () => {
  it('devuelve un PDF válido con el mismo número de páginas que el original', async () => {
    const original = await pdfDeVariasPaginas(2);

    const estampado = await estamparAnulado(original, 'anulada');

    const resultado = await PDFDocument.load(estampado);
    expect(resultado.getPageCount()).toBe(2);
  });

  it('funciona igual para un documento de una sola página con estado "anulado"', async () => {
    const original = await pdfDeVariasPaginas(1);

    const estampado = await estamparAnulado(original, 'anulado');

    const resultado = await PDFDocument.load(estampado);
    expect(resultado.getPageCount()).toBe(1);
  });
});
