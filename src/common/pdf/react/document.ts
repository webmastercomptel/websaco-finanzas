import { createElement, type ReactElement } from 'react';
import {
  Document,
  Page,
  StyleSheet,
  renderToBuffer,
  renderToStream,
  type DocumentProps,
} from '@react-pdf/renderer';

/**
 * No JSX here on purpose — enabling `.tsx`/JSX for this one module tree
 * would mean touching `tsconfig.json`, `.swcrc`, and the Jest transform
 * config project-wide. `React.createElement` keeps the react-pdf migration
 * isolated to new files only, at the cost of more verbose component bodies.
 */

/** Trimmed to the minimum comfortable for a printed page (0.33in ≈ 24pt is
 *  a commonly cited minimum unprintable-area allowance for a laser
 *  printer) from the previous 50pt, which had no documented reason for
 *  being that wide and was simply eating into content space on every
 *  report — same value on all four sides, vertical and horizontal alike. */
const MARGIN = 24;

export const PAGE_STYLES = StyleSheet.create({
  vertical: {
    paddingTop: MARGIN,
    paddingBottom: MARGIN,
    paddingLeft: MARGIN,
    paddingRight: MARGIN,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  horizontal: {
    paddingTop: MARGIN,
    paddingBottom: MARGIN,
    paddingLeft: MARGIN,
    paddingRight: MARGIN,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
});

/** Content width available inside the page margins — mirrors pdf-lib's
 *  `PdfContext.contentWidth`, needed by components that size columns as a
 *  fraction of it (e.g. `Tabla`'s `anchosRelativos`). */
export const CONTENT_WIDTH_PT = 612 - MARGIN * 2;
export const CONTENT_WIDTH_PT_HORIZONTAL = 792 - MARGIN * 2;

/**
 * Builds a single-page Letter report document, portrait or landscape.
 * Every migrated report builder composes its content and passes it here
 * instead of managing its own `<Document>`/`<Page>` wiring.
 */
export function reporteDocumento(
  contenido: ReactElement,
  opciones?: { orientacion?: 'vertical' | 'horizontal' },
): ReactElement<DocumentProps> {
  const horizontal = opciones?.orientacion === 'horizontal';
  return createElement(
    Document,
    null,
    createElement(
      Page,
      {
        size: 'LETTER',
        orientation: horizontal ? 'landscape' : 'portrait',
        style: horizontal ? PAGE_STYLES.horizontal : PAGE_STYLES.vertical,
        wrap: true,
      },
      contenido,
    ),
  );
}

/**
 * Builds a multi-page Letter document, one Page per content element — the
 * react-pdf replacement for pdf-lib's "generate N PDFs, then `copyPages`
 * them into one" batch pattern (`prefacturas-lote-pdf.ts`,
 * `recibos-lote-pdf.ts`). React-pdf has no
 * byte-level merge API; a batch here is one `<Document>` repeating the same
 * per-item content across N `<Page>`s instead of stitching N independently
 * rendered PDFs together.
 */
export function reporteDocumentoMultiPagina(
  paginas: ReactElement[],
  opciones?: { orientacion?: 'vertical' | 'horizontal' },
): ReactElement<DocumentProps> {
  const horizontal = opciones?.orientacion === 'horizontal';
  return createElement(
    Document,
    null,
    ...paginas.map((contenido, i) =>
      createElement(
        Page,
        {
          key: i,
          size: 'LETTER',
          orientation: horizontal ? 'landscape' : 'portrait',
          style: horizontal ? PAGE_STYLES.horizontal : PAGE_STYLES.vertical,
          wrap: true,
        },
        contenido,
      ),
    ),
  );
}

/** Renders a document tree to a Buffer — the server-side entry point
 *  every migrated builder's exported function calls at the end. */
export async function renderizarPdf(
  documento: ReactElement<DocumentProps>,
): Promise<Buffer> {
  return renderToBuffer(documento);
}

/** Renders a document tree to a stream instead of a Buffer — `renderToBuffer`
 *  internally awaits the whole stream and `Buffer.concat`s every chunk before
 *  returning, so an N-page batch lote PDF would sit fully in memory twice
 *  over; the batch builders pipe this straight to the response instead. */
export async function renderizarPdfStream(
  documento: ReactElement<DocumentProps>,
): Promise<NodeJS.ReadableStream> {
  return renderToStream(documento);
}
