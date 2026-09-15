import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  pie: {
    position: 'absolute',
    bottom: 30,
    left: 50,
    right: 50,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  texto: {
    fontSize: 8,
    fontFamily: 'Helvetica',
  },
});

/**
 * Contact info (left) + "Página i/N" (right), repeated on every page —
 * react-pdf equivalent of `escribirPiePagina`. The WebSACO "Generado por"
 * credit used to live here too, but it doesn't need page-repetition
 * semantics the way a page number does — it moved to `CreditoWebsaco`,
 * placed once in the document's own content flow instead (see that
 * component's docblock).
 *
 * Unlike a repeated TABLE header (deferred — see `Tabla`'s docblock), a
 * page footer needs no page-conditional logic: `fixed` alone repeats it at
 * the same bottom position on every page, and the page count is only
 * knowable through the `render` callback's `totalPages`, which is exactly
 * what pdf-lib's version had to wait until every page existed to draw
 * manually.
 */
export function PieDocumento(props: { contacto?: string }): ReactElement {
  return createElement(
    View,
    { style: styles.pie, fixed: true },
    createElement(Text, { style: styles.texto }, props.contacto ?? ''),
    createElement(Text, {
      style: styles.texto,
      render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
        `Página ${pageNumber}/${totalPages}`,
    }),
  );
}
