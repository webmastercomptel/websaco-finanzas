import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import type { CopropiedadDocument } from '../../../database/schemas/copropiedades/copropiedad.schema';

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#e6e6e6',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  nombre: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
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
  dato: {
    flexDirection: 'row',
  },
  etiqueta: {
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
});

/**
 * `EncabezadoDocumento`'s own gray-banner letterhead, ported for the
 * "informes" family (every horizontal/landscape report — Cartera por
 * Conceptos, por Inmueble, Vencimientos, Movimiento Contable, Consecutivos,
 * Listado de Inmuebles, Consulta de Facturación): same banner, same title
 * placement, but the left-hand info column drops to just NIT — a wide
 * report table already crowds the page horizontally, and Dirección/
 * Celular/Email add nothing a report reader needs (unlike an individual
 * document like Factura or Recibo, meant to leave the building on its own).
 *
 * Repeats on every page for a manually-paginated report (see
 * `vencimientos-cartera-pdf.ts` and siblings) exactly like
 * `EncabezadoDocumento` would if it were reused per-page — one call per
 * page's own content, no `position: absolute`/`fixed` involved.
 */
export function EncabezadoInforme(props: {
  copropiedad: CopropiedadDocument;
  titulo: string;
  subtitulo?: string;
}): ReactElement {
  const { copropiedad, titulo, subtitulo } = props;
  const nit = copropiedad.taxId
    ? `${copropiedad.taxId}${copropiedad.taxIdVerificationDigit ? `-${copropiedad.taxIdVerificationDigit}` : ''}`
    : '—';

  return createElement(
    View,
    null,
    createElement(
      View,
      { style: styles.banner },
      createElement(Text, { style: styles.nombre }, copropiedad.name),
    ),
    createElement(
      View,
      { style: styles.filaInfo },
      createElement(
        View,
        { style: styles.dato },
        createElement(Text, { style: styles.etiqueta }, 'NIT:'),
        createElement(Text, { style: styles.valor }, nit),
      ),
      createElement(
        View,
        { style: styles.derecha },
        createElement(Text, { style: styles.titulo }, titulo),
        subtitulo
          ? createElement(Text, { style: styles.subtitulo }, subtitulo)
          : null,
      ),
    ),
    createElement(View, { style: styles.separador }),
  );
}
