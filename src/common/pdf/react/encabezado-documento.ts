import { createElement, type ReactElement } from 'react';
import { Image, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { CopropiedadDocument } from '../../../database/schemas/copropiedades/copropiedad.schema';
import { logoBytesWebsaco } from './logo-websaco';

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#e6e6e6',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  filaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nombre: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
  },
  logoBanner: {
    width: 42,
    marginLeft: 8,
  },
  filaInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 7,
  },
  separador: {
    borderBottomWidth: 0.75,
    borderBottomColor: '#d9d9d9',
    marginBottom: 10,
  },
  datos: {
    flexDirection: 'column',
  },
  dato: {
    flexDirection: 'row',
    marginBottom: 2,
  },
  etiqueta: {
    width: 54,
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  valor: {
    marginLeft: 5,
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  derecha: {
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  titulo: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'right',
  },
  subtitulo: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
    color: '#4d4d4d',
    textAlign: 'right',
    marginTop: 2,
  },
  referenciaPago: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
    textAlign: 'right',
    marginTop: 2,
  },
});

/**
 * Approved letterhead, standardized across every vertical (portrait)
 * document and report: gray banner with the copropiedad's own name, then a
 * label/value contact block (NIT, Dirección, Celular, Email) on the left
 * and the document's own title — plus an optional subtitle, e.g. a cut-off
 * date or period — bold, right-aligned, same row as the contact block's
 * top, on the right.
 *
 * No WebSACO logo in this banner by default — support's own past feedback
 * was that clients are protective of a document that represents THEIR
 * building, not the software that produced it; a vendor mark on their own
 * letterhead reads as an intrusion. `PieDocumento`'s subtle "Generado por"
 * footer credit still carries that same understated branding for every
 * caller. `mostrarLogo` is the one deliberate exception (product decision,
 * 2026-09-19, repositioned 2026-09-20): the 6 financial documents (Factura,
 * Recibo, Nota Crédito, Nota Débito, Nota Contable, Nota de Anticipo) plus
 * Auxiliar de Cartera, Estado de Cuenta and Conciliación de Cartera (added
 * same day, same decision) print the WebSACO mark inside the gray banner,
 * to the right of the copropiedad's own name — not next to the document
 * title, where an earlier pass mistakenly placed it (that spot is the
 * title's own right-aligned line, which stays logo-free now).
 * Every one of those callers passes `copropiedad.showLogoOnDocuments`
 * straight through rather than a literal `true` — a coproperty can opt
 * back OUT per its own "Copropiedades" record (default on), since the
 * earlier product feedback that removed the logo in the first place came
 * from specific clients, not every one of them. Cartera General (the other
 * `EncabezadoDocumento` caller) still defaults to none — no product
 * decision has opted it in, so don't assume that's an oversight.
 *
 * `mostrarNitDebajoTitulo` prints the copropiedad's own NIT (with
 * verification digit) directly under the title, on the same 5 documents
 * EXCEPT Factura — Factura already shows NIT in the left-hand contact
 * block just to its left, so repeating it under the title would be pure
 * duplication there.
 *
 * `EncabezadoInforme` is this same letterhead's horizontal/landscape
 * counterpart (every "informe" — Cartera por Conceptos, Vencimientos,
 * Movimiento Contable, …): same banner and title placement, but the left
 * column drops to just NIT, since a wide report table already crowds the
 * page and Dirección/Celular/Email add nothing a report reader needs.
 *
 * Ends with a thin rule separating it from whatever body comes next
 * (`DatosAdquiriente`, in practice) — self-contained here so every caller
 * gets the same gap instead of each one drawing its own.
 */
export function EncabezadoDocumento(props: {
  copropiedad: CopropiedadDocument;
  titulo: string;
  subtitulo?: string;
  /** The unit's payment reference (`Inmueble.reference`), printed right
   *  below the title in the same plain style the "Emisión" date uses
   *  (`DatosAdquiriente`'s `dd` style) — omitted (null/undefined) whenever
   *  the document has no unit to reference, or the unit has none set. */
  referenciaPago?: string | null;
  /** Prints the WebSACO mark inside the gray banner, to the right of the
   *  copropiedad's own name — see this component's own docblock for which
   *  callers opt in. */
  mostrarLogo?: boolean;
  /** Prints "NIT: <taxId>-<dígito>" directly under the title — see this
   *  component's own docblock for which callers opt in (and why Factura
   *  doesn't). */
  mostrarNitDebajoTitulo?: boolean;
}): ReactElement {
  const {
    copropiedad,
    titulo,
    subtitulo,
    referenciaPago,
    mostrarLogo,
    mostrarNitDebajoTitulo,
  } = props;
  const nit = copropiedad.taxId
    ? `${copropiedad.taxId}${copropiedad.taxIdVerificationDigit ? `-${copropiedad.taxIdVerificationDigit}` : ''}`
    : '—';
  const direccion = [copropiedad.address, copropiedad.city]
    .filter(Boolean)
    .join(' - ');

  const filaDato = (etiqueta: string, valor: string): ReactElement =>
    createElement(
      View,
      { style: styles.dato },
      createElement(Text, { style: styles.etiqueta }, `${etiqueta}:`),
      createElement(Text, { style: styles.valor }, valor),
    );

  return createElement(
    View,
    null,
    createElement(
      View,
      { style: styles.banner },
      createElement(
        View,
        { style: styles.filaBanner },
        createElement(Text, { style: styles.nombre }, copropiedad.name),
        mostrarLogo
          ? createElement(Image, {
              style: styles.logoBanner,
              src: logoBytesWebsaco(),
            })
          : null,
      ),
    ),
    createElement(
      View,
      { style: styles.filaInfo },
      createElement(
        View,
        { style: styles.datos },
        filaDato('NIT', nit),
        filaDato('Dirección', direccion || '—'),
        filaDato('Celular', copropiedad.phone ?? '—'),
        filaDato('Email', copropiedad.email ?? '—'),
      ),
      createElement(
        View,
        { style: styles.derecha },
        createElement(Text, { style: styles.titulo }, titulo),
        mostrarNitDebajoTitulo
          ? createElement(Text, { style: styles.subtitulo }, `NIT: ${nit}`)
          : null,
        subtitulo
          ? createElement(Text, { style: styles.subtitulo }, subtitulo)
          : null,
        referenciaPago
          ? createElement(
              Text,
              { style: styles.referenciaPago },
              `Referencia de Pago: ${referenciaPago}`,
            )
          : null,
      ),
    ),
    createElement(View, { style: styles.separador }),
  );
}
