import {
  crearContexto,
  escribirEncabezado,
  escribirLinea,
  escribirTabla,
  formatoFecha,
  formatoPeso,
} from './pdf-helpers';
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
 * twelve-slot layout).
 */
export async function generarPdfCarteraPorInmueble(
  reporte: RespuestaCarteraPorInmueble,
  copropiedad: CopropiedadDocument,
): Promise<Uint8Array> {
  const ctx = await crearContexto({ orientacion: 'horizontal' });

  escribirEncabezado(
    ctx,
    copropiedad,
    'CARTERA POR INMUEBLE',
    `Inmueble ${reporte.inmuebleCodigo}${reporte.propietario ? ` — ${reporte.propietario}` : ''} — Corte al ${formatoFecha(reporte.fechaCorte)}`,
  );

  const conceptosIndividuales = reporte.cargosPorConcepto.slice(
    0,
    MAX_CARGOS_INDIVIDUALES,
  );
  const conceptosAgrupados = reporte.cargosPorConcepto.slice(
    MAX_CARGOS_INDIVIDUALES,
  );

  const columnas = [
    'Tipo',
    'Número',
    'Fecha',
    'Vence',
    'Saldo',
    ...conceptosIndividuales.map((c) => c.nombre),
    ...(conceptosAgrupados.length > 0 ? ['Otros Cargos'] : []),
  ];
  const anchosRelativos = [
    0.7,
    1.3,
    0.9,
    0.9,
    1.1,
    ...conceptosIndividuales.map(() => 1.1),
    ...(conceptosAgrupados.length > 0 ? [1.1] : []),
  ];
  const columnasNumericas =
    1 + conceptosIndividuales.length + (conceptosAgrupados.length > 0 ? 1 : 0);

  if (reporte.documentos.length === 0) {
    escribirLinea(
      ctx,
      'Este inmueble no tiene cartera pendiente a la fecha de corte.',
    );
    return ctx.doc.save();
  }

  const filaDe = (
    etiquetas: [string, string, string, string],
    saldo: number,
    cargosPorConcepto: Record<string, number>,
  ): string[] => {
    const otros = conceptosAgrupados.reduce(
      (acc, c) => acc + (cargosPorConcepto[c.conceptoId] ?? 0),
      0,
    );
    return [
      ...etiquetas,
      formatoPeso(saldo),
      ...conceptosIndividuales.map((c) =>
        formatoPeso(cargosPorConcepto[c.conceptoId] ?? 0),
      ),
      ...(conceptosAgrupados.length > 0 ? [formatoPeso(otros)] : []),
    ];
  };

  const filas = reporte.documentos.map((d) =>
    filaDe(
      [
        d.tipo,
        d.numeroCompleto,
        formatoFecha(d.fecha),
        d.vence ? formatoFecha(d.vence) : '—',
      ],
      d.saldo,
      d.cargosPorConcepto,
    ),
  );

  const totalOtros = conceptosAgrupados.reduce((acc, c) => acc + c.monto, 0);
  filas.push([
    'TOTAL',
    '',
    '',
    '',
    formatoPeso(reporte.saldoTotalCartera),
    ...conceptosIndividuales.map((c) => formatoPeso(c.monto)),
    ...(conceptosAgrupados.length > 0 ? [formatoPeso(totalOtros)] : []),
  ]);

  escribirTabla(ctx, columnas, filas, {
    columnasNumericas,
    anchosRelativos,
  });

  return ctx.doc.save();
}
