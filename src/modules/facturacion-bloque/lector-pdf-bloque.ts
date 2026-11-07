// src/modules/facturacion-bloque/lector-pdf-bloque.ts
import { Injectable } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

/** A set of pages of the original that becomes one output PDF. */
export interface GrupoDePaginas {
  /** Opaque id the caller gets back with the produced bytes. */
  clave: string;
  /** 1-indexed pages of the original. */
  paginas: number[];
}

/**
 * `Uint8Array` over the SAME memory as `buffer` (no copy: a 200 MB PDF would
 * otherwise exist twice). A `Buffer` that is only a slice of a larger
 * `ArrayBuffer` (Node's small-allocation pool) is copied instead: pdfjs may
 * transfer (detach) the underlying `ArrayBuffer`, which must never be shared
 * memory. Such buffers are < 4 KB, so the copy is negligible.
 */
export function comoUint8Array(buffer: Buffer): Uint8Array {
  return buffer.buffer.byteLength === buffer.byteLength
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
}

/**
 * Text of each page of a PDF, via pdfjs-dist (legacy build). The element `i` is
 * the text of page `i + 1`. Only the unit label is looked for, so the printed id
 * must be selectable text — no OCR.
 *
 * pdfjs is ESM-only (`.mjs`) and is loaded with a dynamic `import()` so it works
 * from the CommonJS runtime Nest builds to. Under Jest that needs Node's
 * `--experimental-vm-modules` (the `test*` scripts pass it).
 *
 * OWNERSHIP: pdfjs takes the array it is given and may detach its
 * `ArrayBuffer`, leaving the caller's view empty. Callers must not reuse `pdf`
 * afterwards (the ingest downloads the file again for the split instead).
 *
 * Memory: pages are read one at a time and `cleanup()`ed, and the pdfjs document
 * is destroyed before returning, so what survives the call is one short string
 * per page, never the parsed document.
 */
export async function extraerTextoPorPagina(
  pdf: Uint8Array,
): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const tareaDeCarga = pdfjs.getDocument({ data: pdf, useSystemFonts: true });
  const documento = await tareaDeCarga.promise;
  const textos: string[] = [];
  try {
    for (let n = 1; n <= documento.numPages; n++) {
      const pagina = await documento.getPage(n);
      const contenido = await pagina.getTextContent();
      textos.push(
        contenido.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' '),
      );
      pagina.cleanup();
    }
  } finally {
    // In this pdfjs version `destroy()` lives on the loading task.
    await tareaDeCarga.destroy();
  }
  return textos;
}

/**
 * Cuts one PDF per group of pages out of `origen` and hands each to `alProducir`
 * the moment it exists, so only ONE output is in memory at a time. The original
 * is parsed once. Throws, before producing anything, when a group is empty or
 * names a page outside the document: a wrong page would be somebody else's
 * invoice.
 */
export async function dividirPorGrupos(
  origen: Uint8Array,
  grupos: ReadonlyArray<GrupoDePaginas>,
  alProducir: (clave: string, pdf: Uint8Array) => Promise<void>,
): Promise<void> {
  const fuente = await PDFDocument.load(origen, { updateMetadata: false });
  const total = fuente.getPageCount();

  for (const grupo of grupos) {
    if (grupo.paginas.length === 0) {
      throw new Error(`El grupo ${grupo.clave} no tiene páginas`);
    }
    for (const pagina of grupo.paginas) {
      if (!Number.isInteger(pagina) || pagina < 1 || pagina > total) {
        throw new Error(`Página ${pagina} fuera de rango (1..${total})`);
      }
    }
  }

  for (const grupo of grupos) {
    const salida = await PDFDocument.create();
    const orden = [...new Set(grupo.paginas)].sort((a, b) => a - b);
    // pdf-lib indexes pages from 0.
    const copiadas = await salida.copyPages(
      fuente,
      orden.map((p) => p - 1),
    );
    copiadas.forEach((pagina) => salida.addPage(pagina));
    await alProducir(grupo.clave, await salida.save());
  }
}

/**
 * Injectable facade over the two PDF operations, so the ingest can be unit
 * tested without parsing real PDFs (and without the ESM flag pdfjs needs).
 */
@Injectable()
export class LectorPdfBloque {
  textoPorPagina(pdf: Uint8Array): Promise<string[]> {
    return extraerTextoPorPagina(pdf);
  }

  dividir(
    origen: Uint8Array,
    grupos: ReadonlyArray<GrupoDePaginas>,
    alProducir: (clave: string, pdf: Uint8Array) => Promise<void>,
  ): Promise<void> {
    return dividirPorGrupos(origen, grupos, alProducir);
  }
}
