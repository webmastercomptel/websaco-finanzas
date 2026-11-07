import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  construirConjuntoConocidas,
  construirMapaPaginas,
  ETIQUETA_UNIDAD,
} from './detector-unidades';
import {
  comoUint8Array,
  dividirPorGrupos,
  extraerTextoPorPagina,
} from './lector-pdf-bloque';

/** A PDF with one line of text per page, built in the test (no binary fixtures). */
async function crearPdf(lineas: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fuente = await doc.embedFont(StandardFonts.Helvetica);
  for (const linea of lineas) {
    const pagina = doc.addPage([300, 200]);
    pagina.drawText(linea, { x: 20, y: 150, size: 14, font: fuente });
  }
  return doc.save();
}

const paginasDe = async (pdf: Uint8Array): Promise<number> =>
  (await PDFDocument.load(pdf)).getPageCount();

/**
 * pdfjs-dist is ESM-only and is loaded with a dynamic import(); under Jest that
 * only works when Node runs with `--experimental-vm-modules` (the `test*` npm
 * scripts pass it). A bare `npx jest` skips these tests instead of failing.
 */
const conModulosVm =
  process.execArgv.includes('--experimental-vm-modules') ||
  (process.env.NODE_OPTIONS ?? '').includes('--experimental-vm-modules');
const describeConPdfjs = conModulosVm ? describe : describe.skip;

describe('dividirPorGrupos', () => {
  it('produce un PDF por grupo con exactamente sus páginas, en el orden del original', async () => {
    const origen = await crearPdf(['A', 'B', 'C', 'D', 'E']);
    const salidas = new Map<string, Uint8Array>();

    await dividirPorGrupos(
      origen,
      [
        { clave: 'u1', paginas: [1, 3] },
        { clave: 'u2', paginas: [2] },
        { clave: 'u3', paginas: [5, 4] },
      ],
      (clave, pdf) => {
        salidas.set(clave, pdf);
        return Promise.resolve();
      },
    );

    expect(await paginasDe(salidas.get('u1') as Uint8Array)).toBe(2);
    expect(await paginasDe(salidas.get('u2') as Uint8Array)).toBe(1);
    expect(await paginasDe(salidas.get('u3') as Uint8Array)).toBe(2);
  });

  it('entrega cada PDF apenas existe y en orden: uno a la vez, sin acumular', async () => {
    const origen = await crearPdf(['A', 'B', 'C']);
    const eventos: string[] = [];

    await dividirPorGrupos(
      origen,
      [
        { clave: 'u1', paginas: [1] },
        { clave: 'u2', paginas: [2] },
        { clave: 'u3', paginas: [3] },
      ],
      async (clave) => {
        eventos.push(`inicio ${clave}`);
        await new Promise((r) => setImmediate(r));
        eventos.push(`fin ${clave}`);
      },
    );

    expect(eventos).toEqual([
      'inicio u1',
      'fin u1',
      'inicio u2',
      'fin u2',
      'inicio u3',
      'fin u3',
    ]);
  });

  it('deduplica las páginas repetidas de un grupo', async () => {
    const origen = await crearPdf(['A', 'B']);
    let paginas = 0;

    await dividirPorGrupos(
      origen,
      [{ clave: 'u1', paginas: [2, 2, 1, 1] }],
      async (_c, pdf) => {
        paginas = await paginasDe(pdf);
      },
    );

    expect(paginas).toBe(2);
  });

  it('una página fuera de rango falla ANTES de producir cualquier salida (una página equivocada sería la factura de otro)', async () => {
    const origen = await crearPdf(['A', 'B']);
    const alProducir = jest.fn().mockResolvedValue(undefined);

    await expect(
      dividirPorGrupos(
        origen,
        [
          { clave: 'u1', paginas: [1] },
          { clave: 'u2', paginas: [3] },
        ],
        alProducir,
      ),
    ).rejects.toThrow('Página 3 fuera de rango (1..2)');
    expect(alProducir).not.toHaveBeenCalled();
  });

  it.each([[0], [-1], [1.5]])('la página %s es inválida', async (pagina) => {
    const origen = await crearPdf(['A']);

    await expect(
      dividirPorGrupos(origen, [{ clave: 'u', paginas: [pagina] }], jest.fn()),
    ).rejects.toThrow('fuera de rango');
  });

  it('un grupo sin páginas falla', async () => {
    const origen = await crearPdf(['A']);

    await expect(
      dividirPorGrupos(origen, [{ clave: 'u', paginas: [] }], jest.fn()),
    ).rejects.toThrow('no tiene páginas');
  });

  it('un PDF corrupto falla al cargar', async () => {
    await expect(
      dividirPorGrupos(
        new Uint8Array([1, 2, 3]),
        [{ clave: 'u', paginas: [1] }],
        jest.fn(),
      ),
    ).rejects.toThrow();
  });
});

describe('comoUint8Array', () => {
  it('comparte la memoria del buffer cuando éste ocupa todo su ArrayBuffer (no duplica un PDF de 200 MB)', () => {
    const buffer = Buffer.from(new ArrayBuffer(4096));

    const vista = comoUint8Array(buffer);

    expect(vista.buffer).toBe(buffer.buffer);
    expect(vista.byteLength).toBe(4096);
  });

  it('copia un buffer que es solo un trozo del pool de Node, para no compartir memoria ajena', () => {
    const pequeno = Buffer.from('abc');

    const vista = comoUint8Array(pequeno);

    expect(Array.from(vista)).toEqual(Array.from(pequeno));
    expect(vista.buffer).not.toBe(pequeno.buffer);
  });
});

describeConPdfjs('extraerTextoPorPagina (pdfjs-dist)', () => {
  // The first dynamic import of the pdfjs bundle is slow on a cold cache.
  jest.setTimeout(30_000);

  it('devuelve el texto de cada página en orden', async () => {
    const pdf = await crearPdf([
      `${ETIQUETA_UNIDAD}: 304T4`,
      `${ETIQUETA_UNIDAD}: 201T2`,
    ]);

    const textos = await extraerTextoPorPagina(pdf);

    expect(textos).toHaveLength(2);
    expect(textos[0]).toContain('304T4');
    expect(textos[1]).toContain('201T2');
  });

  it('de punta a punta: detecta la unidad de cada página y las separa en PDFs que solo contienen las suyas', async () => {
    const origen = await crearPdf([
      `${ETIQUETA_UNIDAD}: 301 Total $100`,
      'Portada sin identificador',
      `${ETIQUETA_UNIDAD}: 302 Total $200`,
      `${ETIQUETA_UNIDAD}: 301 Detalle`,
    ]);

    // pdfjs takes OWNERSHIP of the array it is given (it detaches it), so it
    // gets a copy and `origen` stays usable for the split below.
    const textos = await extraerTextoPorPagina(origen.slice());
    const { unidades, paginasSinMatch } = construirMapaPaginas(
      textos,
      undefined,
      construirConjuntoConocidas(['301', '302']),
    );
    expect(paginasSinMatch).toEqual([2]);
    expect(Object.fromEntries(unidades)).toEqual({
      '301': [1, 4],
      '302': [3],
    });

    const salidas = new Map<string, string[]>();
    await dividirPorGrupos(
      origen,
      [...unidades].map(([clave, paginas]) => ({ clave, paginas })),
      async (clave, pdf) => {
        salidas.set(clave, await extraerTextoPorPagina(pdf));
      },
    );

    const de301 = (salidas.get('301') ?? []).join(' ');
    const de302 = (salidas.get('302') ?? []).join(' ');
    expect(de301).toContain('301 Total');
    expect(de301).toContain('301 Detalle');
    expect(de301).not.toContain('302');
    expect(de302).toContain('302 Total');
    expect(de302).not.toContain('301');
  });

  it('un archivo que no es un PDF rechaza', async () => {
    await expect(
      extraerTextoPorPagina(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow();
  });
});
