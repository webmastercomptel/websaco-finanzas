import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoDocumento } from './react/encabezado-documento';
import { FilaLabelValor } from './react/fila-label-valor';
import { Tabla } from './react/tabla';
import { CreditoWebsaco } from './react/credito-websaco';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  LineaParticipacionCartera,
  RespuestaCarteraGeneral,
} from '../../contracts';

const styles = StyleSheet.create({
  seccionTitulo: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    marginTop: 10,
    marginBottom: 2,
  },
  /** "Doble espacio" before the two breakdown sections (product request,
   *  2026-09-28) — twice `seccionTitulo`'s own top margin. */
  seccionTituloAmplia: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    marginTop: 20,
    marginBottom: 2,
  },
  sinDatos: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
});

const porcentaje = (valor: number): string => `${valor.toFixed(1)}%`;

/** A breakdown section's rows: label, amount, share of the total. */
const tablaParticipacion = (
  tituloPrimeraColumna: string,
  lineas: LineaParticipacionCartera[],
): ReactElement =>
  createElement(Tabla, {
    columnas: [tituloPrimeraColumna, 'Saldo', '% Participación'],
    filas: lineas.map((l) => [
      l.etiqueta,
      formatoPeso(l.monto),
      porcentaje(l.porcentaje),
    ]),
    columnasNumericas: 2,
    striped: true,
    fontSize: 8.5,
  });

/**
 * Cartera General as a PDF: KPIs (each overdue/not-yet-due amount with its
 * share printed next to the label, not after the value), Análisis de
 * Vencimientos by aging bucket, Cartera por Concepto, and Cartera por
 * Estado, each breakdown with its own % Participación column — layout per
 * product request 2026-09-28, which also dropped the Tendencia de Recaudo
 * section, the Mes Anterior / Días Promedio Mora lines and the letterhead's
 * Dirección/Celular/Email (`soloNit`), added the WebSACO mark to the banner
 * whenever the coproperty's `showLogoOnDocuments` allows it (same rule as
 * Recibo/Notas), and kept the standard `CreditoWebsaco` footer.
 */
export async function generarPdfCarteraGeneral(
  reporte: RespuestaCarteraGeneral,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
): Promise<Buffer> {
  const totalPorConcepto = reporte.carteraPorConcepto.reduce(
    (sum, c) => sum + c.saldo,
    0,
  );
  const contenido = createElement(
    View,
    null,
    createElement(EncabezadoDocumento, {
      copropiedad,
      titulo: 'CARTERA GENERAL',
      subtitulo: `Corte al ${formatoFecha(fechaCorte)}`,
      soloNit: true,
      mostrarLogo: copropiedad.showLogoOnDocuments,
    }),
    createElement(FilaLabelValor, {
      label: 'Total Cartera:',
      valor: formatoPeso(reporte.totalCartera),
    }),
    createElement(FilaLabelValor, {
      label: `Monto Vencido (${porcentaje(reporte.porcentajeVencido)}):`,
      valor: formatoPeso(reporte.totalVencido),
    }),
    createElement(FilaLabelValor, {
      label: `Monto sin Vencer (${porcentaje(reporte.porcentajePendiente)}):`,
      valor: formatoPeso(reporte.totalPendiente),
    }),

    createElement(
      Text,
      { style: styles.seccionTituloAmplia },
      'Análisis de Vencimientos',
    ),
    tablaParticipacion('Rango', reporte.analisisVencimientos),

    createElement(
      Text,
      { style: styles.seccionTitulo },
      'Cartera por Concepto',
    ),
    reporte.carteraPorConcepto.length === 0
      ? createElement(
          Text,
          { style: styles.sinDatos },
          'Sin cartera por concepto.',
        )
      : tablaParticipacion(
          'Concepto',
          reporte.carteraPorConcepto.map((c) => ({
            etiqueta: c.nombre,
            monto: c.saldo,
            // Share of the concept breakdown's OWN total, not of
            // `totalCartera`: this section is always "as of now" (see
            // `calcularCarteraPorConcepto`) while `totalCartera` follows the
            // cut-off date, so only this denominator adds up to 100%.
            porcentaje:
              totalPorConcepto > 0 ? (c.saldo / totalPorConcepto) * 100 : 0,
          })),
        ),

    createElement(
      Text,
      { style: styles.seccionTituloAmplia },
      'Cartera por Estado',
    ),
    tablaParticipacion('Estado', reporte.carteraPorEstado),

    createElement(CreditoWebsaco, {}),
  );

  return renderizarPdf(reporteDocumento(contenido));
}
