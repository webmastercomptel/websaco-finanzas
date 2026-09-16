import { createElement } from 'react';
import { View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoInforme } from './react/encabezado-informe';
import { Tabla } from './react/tabla';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaCarteraPorInmueble } from '../../contracts';

/** Up to 11 concepts get their own column; anything beyond that is summed
 *  into one final "Otros Cargos" column — same cap `consulta-facturacion-pdf`
 *  uses, for a coproperty whose concept catalog runs long. */
const MAX_CARGOS_INDIVIDUALES = 11;

/**
 * Generates a real PDF for Cartera por Inmueble: the pending documents of
 * one unit as of a cut-off date, broken down by charge concept — mirrors
 * the on-screen table, dynamic concept columns and all (never a fixed
 * twelve-slot layout). React-pdf, built directly (no pdf-lib version kept
 * behind a `?version=` toggle).
 */
export async function generarPdfCarteraPorInmueble(
  reporte: RespuestaCarteraPorInmueble,
  copropiedad: CopropiedadDocument,
): Promise<Buffer> {
  const encabezado = createElement(EncabezadoInforme, {
    copropiedad,
    titulo: 'CARTERA POR INMUEBLE',
    subtitulo: `Inmueble ${reporte.inmuebleCodigo}${reporte.propietario ? ` — ${reporte.propietario}` : ''} — Corte al ${formatoFecha(reporte.fechaCorte)}`,
  });

  const conceptosIndividuales = reporte.cargosPorConcepto.slice(
    0,
    MAX_CARGOS_INDIVIDUALES,
  );
  const conceptosAgrupados = reporte.cargosPorConcepto.slice(
    MAX_CARGOS_INDIVIDUALES,
  );
  const hayOtros = conceptosAgrupados.length > 0;

  if (reporte.documentos.length === 0) {
    return renderizarPdf(
      reporteDocumento(encabezado, { orientacion: 'horizontal' }),
    );
  }

  const columnas = [
    'Tipo',
    'Número',
    'Fecha',
    'Vence',
    'Saldo',
    ...conceptosIndividuales.map((c) => c.nombre),
    ...(hayOtros ? ['Otros Cargos'] : []),
  ];
  const anchosRelativos = [
    0.7,
    1.3,
    0.9,
    0.9,
    1.1,
    ...conceptosIndividuales.map(() => 1.1),
    ...(hayOtros ? [1.1] : []),
  ];
  const columnasNumericas =
    1 + conceptosIndividuales.length + (hayOtros ? 1 : 0);

  const otrosDe = (cargosPorConcepto: Record<string, number>): number =>
    conceptosAgrupados.reduce(
      (acc, c) => acc + (cargosPorConcepto[c.conceptoId] ?? 0),
      0,
    );
  const cargosDe = (cargosPorConcepto: Record<string, number>): string[] => [
    ...conceptosIndividuales.map((c) =>
      formatoPeso(cargosPorConcepto[c.conceptoId] ?? 0),
    ),
    ...(hayOtros ? [formatoPeso(otrosDe(cargosPorConcepto))] : []),
  ];

  const filas = reporte.documentos.map((d) => [
    d.tipo,
    d.numeroCompleto,
    formatoFecha(d.fecha),
    d.vence ? formatoFecha(d.vence) : '—',
    formatoPeso(d.saldo),
    ...cargosDe(d.cargosPorConcepto),
  ]);

  const totalOtros = conceptosAgrupados.reduce((acc, c) => acc + c.monto, 0);
  const filaTotales = [
    'TOTAL',
    '',
    '',
    '',
    formatoPeso(reporte.saldoTotalCartera),
    ...conceptosIndividuales.map((c) => formatoPeso(c.monto)),
    ...(hayOtros ? [formatoPeso(totalOtros)] : []),
  ];

  return renderizarPdf(
    reporteDocumento(
      createElement(
        View,
        null,
        encabezado,
        createElement(Tabla, {
          columnas,
          filas,
          columnasNumericas,
          anchosRelativos,
          filaTotales,
        }),
      ),
      { orientacion: 'horizontal' },
    ),
  );
}
