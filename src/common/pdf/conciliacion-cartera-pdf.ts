import { createElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoDocumento } from './react/encabezado-documento';
import { FilaLabelValor } from './react/fila-label-valor';
import { Tabla } from './react/tabla';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaConciliacionCartera } from '../../contracts';

const COLUMNAS = [
  'Concepto',
  'Desde',
  'Hasta',
  'Valor Débito',
  'Valor Crédito',
];

const styles = StyleSheet.create({
  seccionTitulo: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    marginTop: 10,
    marginBottom: 2,
  },
  sinDatos: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  alerta: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: '#b30000',
    marginTop: 6,
    marginBottom: 6,
  },
  espacio: {
    marginTop: 4,
  },
});

/**
 * Generates a real PDF for the Conciliación de Cartera control report —
 * mirrors the on-screen table exactly, ten fixed concepts followed by the
 * calculated-vs-real balance comparison (see the service's own docblock on
 * what `diferencia` means). React-pdf, built directly (no pdf-lib version
 * kept behind a `?version=` toggle).
 */
export async function generarPdfConciliacionCartera(
  reporte: RespuestaConciliacionCartera,
  copropiedad: CopropiedadDocument,
): Promise<Buffer> {
  const sinMovimientos = reporte.conceptos.every(
    (c) => c.valorDebito === 0 && c.valorCredito === 0,
  );

  const contenido = createElement(
    View,
    null,
    createElement(EncabezadoDocumento, {
      copropiedad,
      titulo: 'CONCILIACIÓN DE CARTERA',
      subtitulo: `Período ${formatoFecha(reporte.periodStart)} al ${formatoFecha(reporte.periodEnd)}`,
      mostrarLogo: copropiedad.showLogoOnDocuments,
    }),

    createElement(FilaLabelValor, {
      label: 'Saldo Anterior:',
      valor: formatoPeso(reporte.saldoAnterior),
    }),

    // Concepto's own label ("Anulación de Recibos de Caja", …) runs far
    // longer than a short document number — Concepto gets the lion's share
    // of the width, Desde/Hasta only ever hold one document number each.
    createElement(View, { style: styles.espacio }),
    createElement(Tabla, {
      columnas: COLUMNAS,
      filas: reporte.conceptos.map((c) => [
        c.etiqueta,
        c.desde ?? '',
        c.hasta ?? '',
        c.valorDebito > 0 ? formatoPeso(c.valorDebito) : '',
        c.valorCredito > 0 ? formatoPeso(c.valorCredito) : '',
      ]),
      columnasNumericas: 2,
      anchosRelativos: [3, 1, 1, 1.3, 1.3],
      striped: true,
      fontSize: 8.5,
    }),

    createElement(FilaLabelValor, {
      label: 'Total Valor Débito:',
      valor: formatoPeso(reporte.totalDebito),
    }),
    createElement(FilaLabelValor, {
      label: 'Total Valor Crédito:',
      valor: formatoPeso(reporte.totalCredito),
    }),
    createElement(FilaLabelValor, {
      label: 'Saldo de Cartera Calculado:',
      valor: formatoPeso(reporte.saldoCarteraCalculado),
    }),
    createElement(FilaLabelValor, {
      label: 'Saldo de Cartera:',
      valor: formatoPeso(reporte.saldoCarteraReal),
    }),
    createElement(FilaLabelValor, {
      label: 'Diferencia a Conciliar:',
      valor: formatoPeso(reporte.diferencia),
    }),

    reporte.diferencia !== 0
      ? createElement(
          Text,
          { style: styles.alerta },
          'Esta copropiedad presenta diferencias por conciliar en el período seleccionado.',
        )
      : null,

    sinMovimientos
      ? createElement(
          Text,
          { style: styles.sinDatos },
          'No se registraron movimientos de cartera en el período seleccionado.',
        )
      : null,

    createElement(
      Text,
      { style: styles.seccionTitulo },
      'Anticipos Pendientes al Final del Período',
    ),
    reporte.anticiposPendientes.length === 0
      ? createElement(
          Text,
          { style: styles.sinDatos },
          'No hay anticipos pendientes a esa fecha.',
        )
      : createElement(Tabla, {
          columnas: ['Inmueble', 'Fecha', 'No. Recibo', 'Valor'],
          filas: reporte.anticiposPendientes.map((a) => [
            a.inmuebleCodigo,
            formatoFecha(a.fecha),
            a.numeroRecibo,
            formatoPeso(a.valor),
          ]),
          columnasNumericas: 1,
          striped: true,
          fontSize: 8.5,
        }),
  );

  return renderizarPdf(reporteDocumento(contenido));
}
