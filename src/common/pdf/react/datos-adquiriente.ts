import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  contenedor: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  izquierda: {
    flexDirection: 'column',
    width: 300,
  },
  cajaFechas: {
    minWidth: 190,
    borderWidth: 0.75,
    borderColor: '#dcdee1',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  tituloFechas: {
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    color: '#767a80',
    marginBottom: 5,
  },
  filaFecha: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 8.5,
    marginBottom: 3,
  },
  dt: {
    color: '#767a80',
  },
  dd: {
    color: '#292d33',
  },
  pillVence: {
    fontSize: 8.5,
    color: '#c4401f',
    backgroundColor: '#f8e2dc',
    borderRadius: 7,
    paddingVertical: 1.5,
    paddingHorizontal: 6,
  },
  fila: {
    flexDirection: 'row',
    fontSize: 8.5,
    marginBottom: 2,
  },
  etiqueta: {
    width: 110,
  },
  valor: {
    marginLeft: 5,
  },
  filaUso: {
    flexDirection: 'row',
    fontSize: 8.5,
  },
  usoEtiqueta: {
    marginLeft: 20,
    marginRight: 5,
  },
});

/** Values for the right-hand "Periodo" box — omit the whole prop, not just
 *  this type, when the document type doesn't carry a período (see
 *  `DatosAdquiriente`'s own docblock). */
export interface PeriodoDocumento {
  fecha: string;
  vence: string | null;
  desde: string | null;
  hasta: string | null;
}

/**
 * "Datos del Adquirente" — the inmueble/titular identity block every
 * Factura and Estado de Cuenta opens its body with, right below
 * `EncabezadoDocumento`. Two independent halves:
 *  - Left (always shown): código del inmueble, nombre, dirección, celular,
 *    email, identificación + uso. Every label starts flush left at the
 *    same x (no staircase) with its colon glued directly onto the label
 *    text (both in the SAME string, e.g. "NIT:") — the colon's own
 *    position then varies row to row, but every VALUE still lines up,
 *    because the label+colon sits inside a fixed-width left-aligned box:
 *    the value (a sibling element right after that box) always starts at
 *    the box's fixed right edge, regardless of how short or long the
 *    label+colon text inside it was.
 *  - Right (conditional — pass `periodo` only when the document TYPE
 *    actually carries one, e.g. a Factura's billing período; a Recibo has
 *    no período of its own): a small bordered card matching the app's own
 *    info-card convention (`rounded-lg border border-border bg-card`, an
 *    uppercase muted micro-title, `dt`/`dd` rows — see
 *    `factura-detalle.tsx`'s own "Fechas" section, the direct on-screen
 *    analog to this box). Emisión/Vencimiento/Período rows; Vencimiento's
 *    value sits in a soft red pill, the same 15%-tint "danger" treatment
 *    `Badge`'s `danger` tone uses on screen — not because this box IS a
 *    `Badge` (it's plain react-pdf, no shared component), but because that
 *    tint is the app's own established way of drawing the eye without
 *    shouting.
 */
export function DatosAdquiriente(props: {
  inmuebleCodigo: string;
  nombre: string;
  direccion: string;
  celular: string | null;
  email: string | null;
  identificacion: string | null;
  uso: string | null;
  periodo?: PeriodoDocumento;
}): ReactElement {
  const {
    inmuebleCodigo,
    nombre,
    direccion,
    celular,
    email,
    identificacion,
    uso,
    periodo,
  } = props;

  const filaDato = (etiqueta: string, valor: string): ReactElement =>
    createElement(
      View,
      { style: styles.fila },
      createElement(Text, { style: styles.etiqueta }, `${etiqueta}:`),
      createElement(Text, { style: styles.valor }, valor),
    );

  return createElement(
    View,
    { style: styles.contenedor },
    createElement(
      View,
      { style: styles.izquierda },
      filaDato('Código del Inmueble', inmuebleCodigo),
      filaDato('Nombre', nombre),
      filaDato('Dirección', direccion),
      filaDato('Celular', celular ?? '—'),
      filaDato('Email', email ?? '—'),
      createElement(
        View,
        { style: styles.filaUso },
        createElement(Text, { style: styles.etiqueta }, 'Identificación:'),
        createElement(Text, { style: styles.valor }, identificacion ?? '—'),
        uso ? createElement(Text, { style: styles.usoEtiqueta }, 'Uso') : null,
        uso ? createElement(Text, { style: styles.valor }, uso) : null,
      ),
    ),
    periodo
      ? createElement(
          View,
          { style: styles.cajaFechas },
          createElement(Text, { style: styles.tituloFechas }, 'FECHAS'),
          createElement(
            View,
            { style: styles.filaFecha },
            createElement(Text, { style: styles.dt }, 'Emisión'),
            createElement(Text, { style: styles.dd }, periodo.fecha),
          ),
          periodo.vence
            ? createElement(
                View,
                {
                  style: [
                    styles.filaFecha,
                    { marginBottom: periodo.desde && periodo.hasta ? 3 : 0 },
                  ],
                },
                createElement(Text, { style: styles.dt }, 'Vencimiento'),
                createElement(Text, { style: styles.pillVence }, periodo.vence),
              )
            : null,
          periodo.desde && periodo.hasta
            ? createElement(
                View,
                { style: [styles.filaFecha, { marginBottom: 0 }] },
                createElement(Text, { style: styles.dt }, 'Período'),
                createElement(
                  Text,
                  { style: styles.dd },
                  `${periodo.desde} - ${periodo.hasta}`,
                ),
              )
            : null,
        )
      : null,
  );
}
