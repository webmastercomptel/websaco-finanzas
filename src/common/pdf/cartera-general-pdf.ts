import {
  crearContexto,
  escribirEncabezado,
  escribirLabelValor,
  escribirLinea,
  escribirTabla,
  formatoFecha,
  formatoPeso,
} from './pdf-helpers';
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

/**
 * Generates a real PDF for the Cartera General dashboard: the same KPIs and
 * two breakdown tables (por concepto, tendencia de recaudo) the on-screen
 * page shows, printable/shareable outside the browser.
 */
export async function generarPdfCarteraGeneral(
  reporte: RespuestaCarteraGeneral,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  escribirEncabezado(
    ctx,
    copropiedad,
    'CARTERA GENERAL',
    `Corte al ${formatoFecha(fechaCorte)}`,
  );

  escribirLabelValor(ctx, 'Total Cartera:', formatoPeso(reporte.totalCartera));
  escribirLabelValor(
    ctx,
    'Monto Vencido:',
    `${formatoPeso(reporte.totalVencido)} (${reporte.porcentajeVencido.toFixed(1)}%)`,
  );
  escribirLabelValor(
    ctx,
    'Total Pendiente (sin vencer):',
    formatoPeso(reporte.totalPendiente),
  );
  if (reporte.totalCarteraMesAnterior !== null) {
    escribirLabelValor(
      ctx,
      'Total Cartera Mes Anterior:',
      formatoPeso(reporte.totalCarteraMesAnterior),
    );
  }
  escribirLabelValor(
    ctx,
    'Días Promedio Mora:',
    String(reporte.diasPromedioMora),
  );

  ctx.y -= 10;
  escribirLinea(ctx, 'Cartera por Concepto', { bold: true });
  if (reporte.carteraPorConcepto.length === 0) {
    escribirLinea(ctx, 'Sin cartera por concepto.');
  } else {
    escribirTabla(
      ctx,
      ['Concepto', 'Saldo'],
      reporte.carteraPorConcepto.map((c) => [c.nombre, formatoPeso(c.saldo)]),
      { columnasNumericas: 1 },
    );
  }

  ctx.y -= 10;
  escribirLinea(ctx, 'Tendencia de Recaudo (6 meses)', { bold: true });
  if (reporte.tendenciaRecaudo.length === 0) {
    escribirLinea(ctx, 'Sin datos de recaudo.');
  } else {
    escribirTabla(
      ctx,
      ['Mes', 'Recaudo'],
      reporte.tendenciaRecaudo.map((r) => [
        `${MESES[r.mes]} ${r.anio}`,
        formatoPeso(r.monto),
      ]),
      { columnasNumericas: 1 },
    );
  }

  return ctx.doc.save();
}
