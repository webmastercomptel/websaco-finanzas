import { createElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoReporte } from './react/encabezado-reporte';
import { FilaLabelValor } from './react/fila-label-valor';
import { Tabla } from './react/tabla';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaCarteraGeneral } from '../../contracts';

const MESES = [
  '',
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
];

const styles = StyleSheet.create({
  seccionTitulo: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    marginTop: 10,
    marginBottom: 2,
  },
  sinDatos: {
    fontSize: 10,
  },
});

/**
 * React-pdf port of `generarPdfCarteraGeneral` (see `cartera-general-pdf.ts`,
 * kept unchanged and still the one wired into the controller). Batch-1 proof
 * of the shared react-pdf infra — same KPIs and two breakdown tables, same
 * input/output shape, different renderer underneath.
 */
export async function generarPdfCarteraGeneralReactPdf(
  reporte: RespuestaCarteraGeneral,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
): Promise<Buffer> {
  const contenido = createElement(
    View,
    null,
    createElement(EncabezadoReporte, {
      copropiedad,
      titulo: 'CARTERA GENERAL',
      subtitulo: `Corte al ${formatoFecha(fechaCorte)}`,
    }),
    createElement(FilaLabelValor, {
      label: 'Total Cartera:',
      valor: formatoPeso(reporte.totalCartera),
    }),
    createElement(FilaLabelValor, {
      label: 'Monto Vencido:',
      valor: `${formatoPeso(reporte.totalVencido)} (${reporte.porcentajeVencido.toFixed(1)}%)`,
    }),
    createElement(FilaLabelValor, {
      label: 'Total Pendiente (sin vencer):',
      valor: formatoPeso(reporte.totalPendiente),
    }),
    reporte.totalCarteraMesAnterior !== null
      ? createElement(FilaLabelValor, {
          label: 'Total Cartera Mes Anterior:',
          valor: formatoPeso(reporte.totalCarteraMesAnterior),
        })
      : null,
    createElement(FilaLabelValor, {
      label: 'Días Promedio Mora:',
      valor: String(reporte.diasPromedioMora),
    }),

    createElement(Text, { style: styles.seccionTitulo }, 'Cartera por Concepto'),
    reporte.carteraPorConcepto.length === 0
      ? createElement(Text, { style: styles.sinDatos }, 'Sin cartera por concepto.')
      : createElement(Tabla, {
          columnas: ['Concepto', 'Saldo'],
          filas: reporte.carteraPorConcepto.map((c) => [
            c.nombre,
            formatoPeso(c.saldo),
          ]),
          columnasNumericas: 1,
        }),

    createElement(
      Text,
      { style: styles.seccionTitulo },
      'Tendencia de Recaudo (6 meses)',
    ),
    reporte.tendenciaRecaudo.length === 0
      ? createElement(Text, { style: styles.sinDatos }, 'Sin datos de recaudo.')
      : createElement(Tabla, {
          columnas: ['Mes', 'Recaudo'],
          filas: reporte.tendenciaRecaudo.map((r) => [
            `${MESES[r.mes]} ${r.anio}`,
            formatoPeso(r.monto),
          ]),
          columnasNumericas: 1,
        }),
  );

  return renderizarPdf(reporteDocumento(contenido));
}
