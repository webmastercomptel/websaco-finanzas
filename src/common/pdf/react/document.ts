import { createElement, type ReactElement } from 'react';
import {
  Document,
  Page,
  StyleSheet,
  renderToBuffer,
  type DocumentProps,
} from '@react-pdf/renderer';

/**
 * No JSX here on purpose — enabling `.tsx`/JSX for this one module tree
 * would mean touching `tsconfig.json`, `.swcrc`, and the Jest transform
 * config project-wide. `React.createElement` keeps the react-pdf migration
 * isolated to new files only, at the cost of more verbose component bodies.
 */

const MARGIN = 50;

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

/** Renders a document tree to a Buffer — the server-side entry point
 *  every migrated builder's exported function calls at the end. */
export async function renderizarPdf(
  documento: ReactElement<DocumentProps>,
): Promise<Buffer> {
  return renderToBuffer(documento);
}
