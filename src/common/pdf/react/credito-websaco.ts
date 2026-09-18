import { createElement, type ReactElement } from 'react';
import { Image, StyleSheet, Text, View } from '@react-pdf/renderer';
import { logoBytesWebsaco } from './logo-websaco';

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
    fontFamily: 'Helvetica',
  },
  textoConMargen: {
    fontSize: 7,
    fontFamily: 'Helvetica',
    marginRight: 4,
  },
  textoConMargenIzquierdo: {
    fontSize: 7,
    fontFamily: 'Helvetica',
    marginLeft: 4,
  },
  logo: {
    width: 28,
  },
});

/**
 * "Generado por [logo]" on the left, "Página i/N" on the right — same
 * faint gray, same size, read as one unit instead of two unrelated footer
 * concerns. Placed in-flow, once per `<Page>` element it's put on — for a
 * single-page document (Factura, Estado de Cuenta) that's naturally once
 * per document; for a manually-paginated wide report (Vencimientos,
 * Movimiento Contable, Consulta/Consecutivos de Facturación — each page
 * built by hand, one `<Page>` per row-chunk), the caller puts one
 * `CreditoWebsaco` on each page's own content, so it repeats correctly
 * without needing `position: absolute` at all.
 *
 * A `position: absolute` + `fixed` variant was tried for the wide-report
 * case and dropped: react-pdf's automatic `wrap` pagination doesn't
 * reserve space for a `fixed` element sitting outside the flow, so
 * flowed rows kept overlapping it near the bottom of a full page
 * regardless of how much extra bottom padding was added — the two never
 * converged. Manual per-page pagination (see `vencimientos-cartera-pdf.ts`)
 * sidesteps the interaction entirely instead of fighting it.
 *
 * The WebSACO mark itself replaces the logo that used to sit in
 * `EncabezadoDocumento`'s masthead banner — support's feedback was that
 * clients are protective of a document representing THEIR building; a
 * vendor mark in the margin, not the letterhead, is the same understated
 * mention most SaaS invoicing tools use.
 *
 * `idInmueble`, when passed, prints "ID: <code>" immediately before
 * "Generado por" — the unit-code field a Factura/Prefactura used to show
 * elsewhere and was later dropped; restored here rather than in the body,
 * per product decision. Every other caller omits it and sees no change.
 *
 * `creditoComptel`, when true, appends "Comptel-System Ltda, NIT
 * 800.010.333-2" right after the WebSACO mark — Comptel-System is the
 * reseller of record and its NIT is required on the invoice itself, per
 * product decision. Only `factura-pdf.ts` passes it; every other caller
 * omits it and sees no change.
 */
export function CreditoWebsaco(props: {
  idInmueble?: string | null;
  creditoComptel?: boolean;
}): ReactElement {
  const { idInmueble, creditoComptel } = props;
  return createElement(
    View,
    { style: styles.contenedor },
    createElement(
      View,
      { style: styles.marca },
      idInmueble
        ? createElement(
            Text,
            { style: styles.textoConMargen },
            `ID: ${idInmueble}`,
          )
        : null,
      createElement(Text, { style: styles.textoConMargen }, 'Generado por'),
      createElement(Image, { style: styles.logo, src: logoBytesWebsaco() }),
      creditoComptel
        ? createElement(
            Text,
            { style: styles.textoConMargenIzquierdo },
            '· Comptel-System Ltda, NIT 800.010.333-2',
          )
        : null,
    ),
    createElement(Text, {
      style: styles.texto,
      render: ({
        pageNumber,
        totalPages,
      }: {
        pageNumber: number;
        totalPages: number;
      }) => `Página ${pageNumber}/${totalPages}`,
    }),
  );
}
