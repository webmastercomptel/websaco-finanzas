import { createElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import type { Style } from '@react-pdf/types';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoDocumento } from './react/encabezado-documento';
import { CreditoWebsaco } from './react/credito-websaco';
import { FONDO_ZEBRA } from './react/paleta';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaAuxiliarCartera } from '../../contracts';

/** Same weights as the pdf-lib original's `ANCHOS_COLUMNA` (55/30/50/140/
 *  55/60/60/62, summing to 512pt — the exact Letter-portrait content width),
 *  reused directly as relative flex weights. Concepto gets the lion's
 *  share as free text; Tipo/Nº Doc are short fixed identifiers. */
const PESOS = [55, 30, 50, 140, 55, 60, 60, 62];
const COLUMNAS = [
  'Fecha',
  'Tipo',
  'Nº Doc',
  'Concepto',
  'Ref/Cruce',
  'Débito',
  'Crédito',
  'Saldo',
];
const PRIMERA_NUMERICA = 5;

const styles = StyleSheet.create({
  bloque: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  bloqueIzquierda: {
    width: 300,
  },
  filaSimple: {
    flexDirection: 'row',
    marginBottom: 2,
  },
  filaSimpleLabel: {
    width: 55,
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  filaSimpleValor: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  periodo: {
    flexDirection: 'row',
  },
  periodoLabel: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  periodoValor: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  filaEncabezado: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#999999',
    paddingBottom: 4,
    marginBottom: 3,
  },
  fila: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  filaPar: {
    backgroundColor: FONDO_ZEBRA,
  },
  filaBarra: {
    flexDirection: 'row',
    backgroundColor: '#e6e6e6',
    paddingVertical: 3,
    marginVertical: 2,
  },
  celdaEncabezado: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
  },
  celda: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  celdaBarra: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
  },
  sinMovimientos: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
    marginVertical: 6,
  },
});

const celdaStyle = (
  i: number,
  variante: 'encabezado' | 'normal' | 'barra',
): Style => ({
  flexGrow: PESOS[i],
  flexBasis: 0,
  textAlign: i >= PRIMERA_NUMERICA ? 'right' : 'left',
  paddingRight: 4,
  ...(variante === 'encabezado'
    ? styles.celdaEncabezado
    : variante === 'barra'
      ? styles.celdaBarra
      : styles.celda),
});

const filaBarra = (valores: string[], key: string) =>
  createElement(
    View,
    { key, style: styles.filaBarra, wrap: false },
    ...valores.map((v, i) =>
      createElement(Text, { key: i, style: celdaStyle(i, 'barra') }, v),
    ),
  );

/** Label in a fixed-width box + value right after with a small gap — same
 *  column-aligned convention `DatosAdquiriente` uses, not `FilaInfo`'s
 *  space-between (which needs a full-width row to look right; this sits in
 *  a narrower half-width column alongside Periodo and looked disjointed
 *  spread edge to edge). */
const filaSimple = (label: string, valor: string, key: string) =>
  createElement(
    View,
    { key, style: styles.filaSimple },
    createElement(Text, { style: styles.filaSimpleLabel }, label),
    createElement(Text, { style: styles.filaSimpleValor }, valor),
  );

/**
 * Generates a real PDF for the Auxiliar de Cartera ledger: one inmueble's
 * movements across all five document types for a date range, opening on
 * "Saldo Anterior" and closing on "Saldo Final". React-pdf, built directly
 * (no pdf-lib version kept behind a `?version=` toggle — see the migration
 * notes in `../../../CLAUDE.md`'s "Decisions pending claude-mem save" once
 * this lands: direct cutover, not a dual-path stage, is the settled
 * approach for the rest of this migration).
 *
 * The gray-bar "Saldo Anterior"/"Saldo Final" bookend rows don't fit the
 * generic `Tabla` component (built for header+rows+one optional totals row
 * at the end, not a bar at both ends) — bespoke table markup here, same
 * spirit as `CuerpoFactura` being its own component rather than a `Tabla`
 * variant.
 */
export async function generarPdfAuxiliarCartera(
  reporte: RespuestaAuxiliarCartera,
  copropiedad: CopropiedadDocument,
): Promise<Buffer> {
  const contenido = createElement(
    View,
    null,
    createElement(EncabezadoDocumento, {
      copropiedad,
      titulo: 'Auxiliar de Cartera',
      mostrarLogo: copropiedad.showLogoOnDocuments,
    }),

    createElement(
      View,
      { style: styles.bloque },
      createElement(
        View,
        { style: styles.bloqueIzquierda },
        filaSimple('Inmueble:', reporte.inmuebleCodigo, 'inmueble'),
        filaSimple('Nombre:', reporte.propietario ?? '—', 'nombre'),
      ),
      createElement(
        View,
        { style: styles.periodo },
        createElement(Text, { style: styles.periodoLabel }, 'Periodo: '),
        createElement(
          Text,
          { style: styles.periodoValor },
          `${formatoFecha(reporte.desde)} al ${formatoFecha(reporte.hasta)}`,
        ),
      ),
    ),

    createElement(
      View,
      { style: styles.filaEncabezado, wrap: false },
      ...COLUMNAS.map((col, i) =>
        createElement(
          Text,
          { key: i, style: celdaStyle(i, 'encabezado') },
          col,
        ),
      ),
    ),

    filaBarra(
      [
        '',
        '',
        '',
        'Saldo Anterior',
        '',
        '',
        '',
        formatoPeso(reporte.saldoInicial),
      ],
      'inicial',
    ),

    ...reporte.movimientos.map((m, i) =>
      createElement(
        View,
        {
          key: i,
          style: i % 2 === 1 ? [styles.fila, styles.filaPar] : styles.fila,
          wrap: false,
        },
        createElement(
          Text,
          { style: celdaStyle(0, 'normal') },
          formatoFecha(m.fecha),
        ),
        createElement(Text, { style: celdaStyle(1, 'normal') }, m.tipo),
        createElement(
          Text,
          { style: celdaStyle(2, 'normal') },
          m.numeroCompleto,
        ),
        createElement(Text, { style: celdaStyle(3, 'normal') }, m.concepto),
        createElement(
          Text,
          { style: celdaStyle(4, 'normal') },
          m.refCruce ?? '',
        ),
        createElement(
          Text,
          { style: celdaStyle(5, 'normal') },
          m.debito ? formatoPeso(m.debito) : '',
        ),
        createElement(
          Text,
          { style: celdaStyle(6, 'normal') },
          m.credito ? formatoPeso(m.credito) : '',
        ),
        createElement(
          Text,
          { style: celdaStyle(7, 'normal') },
          formatoPeso(m.saldo),
        ),
      ),
    ),

    reporte.movimientos.length === 0
      ? createElement(
          Text,
          { style: styles.sinMovimientos },
          'Este inmueble no tiene movimientos en el rango seleccionado',
        )
      : null,

    filaBarra(
      [
        '',
        '',
        '',
        'Saldo Final',
        '',
        formatoPeso(reporte.totalDebitos),
        formatoPeso(reporte.totalCreditos),
        formatoPeso(reporte.saldoFinal),
      ],
      'final',
    ),

    createElement(CreditoWebsaco, {}),
  );

  return renderizarPdf(reporteDocumento(contenido));
}
