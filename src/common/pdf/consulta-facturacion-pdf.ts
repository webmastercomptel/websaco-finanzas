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
import type { RespuestaConsultaFacturacion } from '../../contracts';

const COLUMNAS_FIJAS = [
  'Inmueble',
  'Tipo',
  'Prefijo',
  'Número',
  'Fecha Factura',
  'Fecha Vence',
];

/** Max concept columns per table pass — landscape Letter at 10pt only fits
 *  so many alongside the six identifying columns. */
const CONCEPTOS_POR_GRUPO = 6;

function agruparEn<T>(items: T[], tamano: number): T[][] {
  const grupos: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) {
    grupos.push(items.slice(i, i + tamano));
  }
  return grupos.length > 0 ? grupos : [[]];
}

/**
 * Generates the "Consulta de Facturación" report PDF: per-concept totals
 * plus a per-invoice detail table for one lote. Landscape, unlike every
 * other PDF in this module — the identifying columns alone already exceed
 * portrait Letter's content width. A separate builder from
 * `generarPdfFacturasLote` (which prints one invoice per page); this one is
 * a single aggregate table, not a bundle of individual documents.
 */
export async function generarPdfConsultaFacturacion(
  reporte: RespuestaConsultaFacturacion,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const ctx = await crearContexto({ orientacion: 'horizontal' });

  escribirEncabezado(
    ctx,
    copropiedad,
    'CONSULTA DE FACTURACIÓN',
    `Lote No. ${reporte.loteNumero} — Fecha de facturación ${formatoFecha(reporte.fechaFacturacion)}`,
  );

  escribirLinea(ctx, 'Resumen por Concepto', { bold: true });
  for (const c of reporte.totalesPorConcepto) {
    escribirLabelValor(ctx, c.nombreConcepto, formatoPeso(c.monto));
  }
  ctx.y -= 4;
  escribirLabelValor(ctx, 'Subtotal:', formatoPeso(reporte.subtotal));
  escribirLabelValor(ctx, 'Valor IVA:', formatoPeso(reporte.totalImpuestos));
  escribirLabelValor(ctx, 'Total Facturación:', formatoPeso(reporte.total));

  ctx.y -= 10;
  escribirLinea(ctx, 'Detalle de Facturas', { bold: true });

  const grupos = agruparEn(reporte.totalesPorConcepto, CONCEPTOS_POR_GRUPO);
  for (const [i, grupo] of grupos.entries()) {
    if (grupos.length > 1) {
      escribirLinea(
        ctx,
        `Cargos por concepto (grupo ${i + 1} de ${grupos.length})`,
        { size: 9 },
      );
    }
    const columnas = [...COLUMNAS_FIJAS, ...grupo.map((c) => c.nombreConcepto)];
    const filas = reporte.filas.map((f) => [
      f.inmuebleCodigo,
      f.tipoDocumento,
      f.prefijo,
      String(f.numero),
      formatoFecha(f.fechaFactura),
      formatoFecha(f.fechaVence),
      ...grupo.map((c) => formatoPeso(f.valoresPorConcepto[c.conceptoId] ?? 0)),
    ]);
    escribirTabla(ctx, columnas, filas, { columnasNumericas: grupo.length });
    ctx.y -= 6;
  }

  return ctx.doc.save();
}
