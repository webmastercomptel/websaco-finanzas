import { createElement, type ReactElement } from 'react';
import { Image, StyleSheet, Text, View } from '@react-pdf/renderer';
import { logoBytesWebsaco } from './logo-websaco';
import { TEXTO_MUTED } from './paleta';

const styles = StyleSheet.create({
  contenedor: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  marca: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  texto: {
    fontSize: 7,
    color: TEXTO_MUTED,
  },
  textoConMargen: {
    fontSize: 7,
    color: TEXTO_MUTED,
    marginRight: 4,
  },
  logo: {
    width: 28,
  },
});

/**
 * One row closing the document's content: "Generado por [logo]" on the
 * left, "Página i/N" on the right — same faint gray, same size, read as one
 * unit instead of two unrelated footer concerns. Placed ONCE in the
 * document's own flow (right after Observaciones, in practice), not pinned
 * to the page's absolute bottom edge (`PieDocumento`, still available for a
 * document that genuinely needs a footer repeated identically on every
 * page — the wide multi-page reports migrating later are the likely case).
 * A single-page Factura/Estado de Cuenta never needed that repetition
 * (`Página 1/1` is not information); pageNumber/totalPages still come from
 * react-pdf's own per-page `render` callback either way.
 *
 * The WebSACO mark itself replaces the logo that used to sit in
 * `EncabezadoDocumento`'s masthead banner — support's feedback was that
 * clients are protective of a document representing THEIR building; a
 * vendor mark in the margin, not the letterhead, is the same understated
 * mention most SaaS invoicing tools use.
 */
export function CreditoWebsaco(): ReactElement {
  return createElement(
    View,
    { style: styles.contenedor },
    createElement(
      View,
      { style: styles.marca },
      createElement(Text, { style: styles.textoConMargen }, 'Generado por'),
      createElement(Image, { style: styles.logo, src: logoBytesWebsaco() }),
    ),
    createElement(Text, {
      style: styles.texto,
      render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
        `Página ${pageNumber}/${totalPages}`,
    }),
  );
}
