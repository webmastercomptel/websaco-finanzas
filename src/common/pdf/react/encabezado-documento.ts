import { createElement, type ReactElement } from 'react';
import { Image, StyleSheet, Text, View } from '@react-pdf/renderer';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CopropiedadDocument } from '../../../database/schemas/copropiedades/copropiedad.schema';

/** Same asset `embebirLogoWebsaco` (pdf-lib) reads — one logo file, two
 *  renderers. A raw path string made react-pdf's `Image` try to `fetch()`
 *  it (fails in this environment, and is fragile on Windows paths anyway)
 *  — a pre-read Buffer skips that resolver entirely. Read once per process,
 *  same reasoning as pdf-lib's own `cargarLogoBytes` cache. */
let logoBytesCache: Buffer | null = null;
function logoBytes(): Buffer {
  logoBytesCache ??= readFileSync(
    join(__dirname, '../../assets/websaco-logo.png'),
  );
  return logoBytesCache;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#e6e6e6',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  nombre: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
  },
  logo: {
    width: 72,
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
    fontSize: 8.5,
    marginBottom: 2,
  },
  etiqueta: {
    width: 54,
  },
  valor: {
    marginLeft: 5,
  },
  titulo: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'right',
  },
});

/**
 * Approved letterhead for Factura and Estado de Cuenta: gray banner with
 * copropiedad name + logo, then a label/value contact block (NIT,
 * Dirección, Celular, Email) on the left and the document's own title
 * (bold, right-aligned, same row as the contact block's top) on the right.
 *
 * Distinct from `EncabezadoReporte` (text-only, no banner/logo — used by
 * Cartera General/Conciliación) and from pdf-lib's own
 * `dibujarEncabezadoDocumento` (same banner spirit, but only shows NIT, not
 * the full contact block) — this is the react-pdf port of the newly
 * approved design, wider than either predecessor.
 *
 * Ends with a thin rule separating it from whatever body comes next
 * (`DatosAdquiriente`, in practice) — self-contained here so every caller
 * gets the same gap instead of each one drawing its own.
 */
export function EncabezadoDocumento(props: {
  copropiedad: CopropiedadDocument;
  titulo: string;
}): ReactElement {
  const { copropiedad, titulo } = props;
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
      createElement(Text, { style: styles.nombre }, copropiedad.name),
      createElement(Image, { style: styles.logo, src: logoBytes() }),
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
      createElement(Text, { style: styles.titulo }, titulo),
    ),
    createElement(View, { style: styles.separador }),
  );
}
