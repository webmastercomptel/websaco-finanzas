import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import type { CopropiedadDocument } from '../../../database/schemas/copropiedades/copropiedad.schema';

const styles = StyleSheet.create({
  container: {
    marginBottom: 14,
  },
  nombre: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
  },
  linea: {
    fontSize: 10,
    marginBottom: 3,
  },
  titulo: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'center',
    marginTop: 10,
  },
  subtitulo: {
    fontSize: 10,
    textAlign: 'center',
    color: '#4d4d4d',
    marginTop: 4,
  },
});

/**
 * Text-only copropiedad letterhead: name, address/city, NIT, phone/email,
 * then a centered document title and optional subtitle. React-pdf equivalent
 * of `escribirEncabezado` in `pdf-helpers.ts` — used by report-style
 * documents that have no logo banner (Cartera General, Conciliación de
 * Cartera, and the rest of the "reporte" family as they migrate).
 */
export function EncabezadoReporte(props: {
  copropiedad: CopropiedadDocument;
  titulo: string;
  subtitulo?: string;
}): ReactElement {
  const { copropiedad, titulo, subtitulo } = props;
  const direccion = [copropiedad.address, copropiedad.city]
    .filter(Boolean)
    .join(', ');
  const nit = copropiedad.taxId
    ? `NIT ${copropiedad.taxId}${copropiedad.taxIdVerificationDigit ? `-${copropiedad.taxIdVerificationDigit}` : ''}`
    : null;
  const contacto = [copropiedad.phone, copropiedad.email]
    .filter(Boolean)
    .join(' | ');

  return createElement(
    View,
    { style: styles.container },
    createElement(Text, { style: styles.nombre }, copropiedad.name),
    direccion
      ? createElement(Text, { style: styles.linea }, direccion)
      : null,
    nit ? createElement(Text, { style: styles.linea }, nit) : null,
    contacto ? createElement(Text, { style: styles.linea }, contacto) : null,
    createElement(Text, { style: styles.titulo }, titulo),
    subtitulo
      ? createElement(Text, { style: styles.subtitulo }, subtitulo)
      : null,
  );
}
