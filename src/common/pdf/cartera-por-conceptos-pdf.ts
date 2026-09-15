import {
  crearContexto,
  escribirEncabezado,
  escribirLinea,
  escribirTabla,
  formatoFecha,
  formatoPeso,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaCarteraPorConceptos } from '../../contracts';

/** Up to 8 concepts get their own column — narrower than Cartera por
 *  Inmueble's 11, since this report also carries an Inmueble/Titular column
 *  (detallado) that one doesn't. Anything beyond is summed into one final
 *  "Otros Cargos" column. Only used in the "todos los conceptos" layout —
 *  the "un solo concepto" layout never has more than its own one column. */
const MAX_CARGOS_INDIVIDUALES = 8;

/** cargo/saldo * 100, or "—" when there is nothing to divide by (never
 *  happens for a real row — a document with saldo <= 0 is excluded
 *  upstream — but a totals row is a derived sum worth guarding on its own). */
function formatoPorcentaje(cargo: number, saldo: number): string {
  return saldo > 0 ? `${((cargo / saldo) * 100).toFixed(1)}%` : '—';
}

/**
 * Generates a real PDF for Cartera por Conceptos, in one of two shapes:
 *
 * - Every concept at once (`conceptoId` omitted): the "Por Inmueble" tab's
 *   own layout — one column per concept (capped, see `MAX_CARGOS_INDIVIDUALES`),
 *   "resumido" (one row per inmueble) or "detallado" (one row per document).
 * - One single concept (`conceptoId` given): the "Por Concepto" tab's own
 *   layout — filtered to documents carrying that one charge, with a single
 *   named cargo column plus a "% Participación" column (cargo/saldo), same
 *   resumido/detallado split.
 */
export async function generarPdfCarteraPorConceptos(
  reporte: RespuestaCarteraPorConceptos,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
  tipo: 'resumido' | 'detallado',
  conceptoId?: string,
): Promise<Uint8Array> {
  return conceptoId
    ? generarPorConcepto(reporte, copropiedad, fechaCorte, tipo, conceptoId)
    : generarPorInmueble(reporte, copropiedad, fechaCorte, tipo);
}

async function generarPorInmueble(
  reporte: RespuestaCarteraPorConceptos,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
  tipo: 'resumido' | 'detallado',
): Promise<Uint8Array> {
  const ctx = await crearContexto({ orientacion: 'horizontal' });

  escribirEncabezado(
    ctx,
    copropiedad,
    'CARTERA POR CONCEPTOS',
    `${tipo === 'resumido' ? 'Resumido' : 'Detallado'} — Corte al ${formatoFecha(fechaCorte)}`,
  );

  if (reporte.grupos.length === 0) {
    escribirLinea(ctx, 'No hay cartera pendiente en esta copropiedad.');
    return ctx.doc.save();
  }

  const conceptosIndividuales = reporte.conceptos.slice(
    0,
    MAX_CARGOS_INDIVIDUALES,
  );
  const conceptosAgrupados = reporte.conceptos.slice(MAX_CARGOS_INDIVIDUALES);
  const hayOtros = conceptosAgrupados.length > 0;

  const sumaCargos = (
    cargosPorConcepto: Record<string, number>,
    conceptos: { conceptoId: string }[],
  ): number =>
    conceptos.reduce(
      (acc, c) => acc + (cargosPorConcepto[c.conceptoId] ?? 0),
      0,
    );

  const columnasCargos = [
    ...conceptosIndividuales.map((c) => c.nombre),
    ...(hayOtros ? ['Otros Cargos'] : []),
  ];
  const cargosDe = (cargosPorConcepto: Record<string, number>): string[] => [
    ...conceptosIndividuales.map((c) =>
      formatoPeso(cargosPorConcepto[c.conceptoId] ?? 0),
    ),
    ...(hayOtros
      ? [formatoPeso(sumaCargos(cargosPorConcepto, conceptosAgrupados))]
      : []),
  ];

  const granTotalCargos: Record<string, number> = {};
  for (const g of reporte.grupos) {
    for (const d of g.documentos) {
      for (const [conceptoId, monto] of Object.entries(d.cargosPorConcepto)) {
        granTotalCargos[conceptoId] =
          (granTotalCargos[conceptoId] ?? 0) + monto;
      }
    }
  }
  const granTotalSaldo = reporte.grupos.reduce(
    (sum, g) => sum + g.saldoTotal,
    0,
  );

  if (tipo === 'resumido') {
    const columnas = [
      'Inmueble',
      'Titular',
      'Celular',
      'Saldo',
      ...columnasCargos,
    ];
    const anchosRelativos = [0.8, 1.6, 1, 1, ...columnasCargos.map(() => 1.1)];

    const filas = reporte.grupos.map((g) => {
      const cargosGrupo: Record<string, number> = {};
      for (const d of g.documentos) {
        for (const [conceptoId, monto] of Object.entries(d.cargosPorConcepto)) {
          cargosGrupo[conceptoId] = (cargosGrupo[conceptoId] ?? 0) + monto;
        }
      }
      return [
        g.inmuebleCodigo,
        g.titular ?? '—',
        g.celular ?? '—',
        formatoPeso(g.saldoTotal),
        ...cargosDe(cargosGrupo),
      ];
    });
    filas.push([
      'GRAN TOTAL',
      '',
      '',
      formatoPeso(granTotalSaldo),
      ...cargosDe(granTotalCargos),
    ]);

    escribirTabla(ctx, columnas, filas, {
      columnasNumericas: 1 + columnasCargos.length,
      anchosRelativos,
    });
  } else {
    const columnas = [
      'Inmueble',
      'Titular',
      'Fecha',
      'Tipo',
      'Número',
      'Vence',
      'Saldo',
      ...columnasCargos,
    ];
    const anchosRelativos = [
      0.7,
      1.4,
      0.8,
      0.6,
      1,
      0.8,
      1,
      ...columnasCargos.map(() => 1.1),
    ];

    const filas = reporte.grupos.flatMap((g) =>
      g.documentos.map((d) => [
        g.inmuebleCodigo,
        g.titular ?? '—',
        formatoFecha(d.fecha),
        d.tipo,
        d.numeroCompleto,
        d.vence ? formatoFecha(d.vence) : '—',
        formatoPeso(d.saldo),
        ...cargosDe(d.cargosPorConcepto),
      ]),
    );
    filas.push([
      'GRAN TOTAL',
      '',
      '',
      '',
      '',
      '',
      formatoPeso(granTotalSaldo),
      ...cargosDe(granTotalCargos),
    ]);

    escribirTabla(ctx, columnas, filas, {
      columnasNumericas: 1 + columnasCargos.length,
      anchosRelativos,
    });
  }

  return ctx.doc.save();
}

async function generarPorConcepto(
  reporte: RespuestaCarteraPorConceptos,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
  tipo: 'resumido' | 'detallado',
  conceptoId: string,
): Promise<Uint8Array> {
  const ctx = await crearContexto({ orientacion: 'horizontal' });
  const nombreCargo =
    reporte.conceptos.find((c) => c.conceptoId === conceptoId)?.nombre ??
    'Cargo';

  escribirEncabezado(
    ctx,
    copropiedad,
    'CARTERA POR CONCEPTOS',
    `${tipo === 'resumido' ? 'Resumido' : 'Detallado'} — ${nombreCargo} — Corte al ${formatoFecha(fechaCorte)}`,
  );

  const grupos = reporte.grupos
    .map((g) => {
      const documentos = g.documentos.filter(
        (d) => (d.cargosPorConcepto[conceptoId] ?? 0) > 0,
      );
      return { ...g, documentos };
    })
    .filter((g) => g.documentos.length > 0);

  if (grupos.length === 0) {
    escribirLinea(
      ctx,
      'No hay cartera pendiente para este cargo en esta copropiedad.',
    );
    return ctx.doc.save();
  }

  const saldoDe = (documentos: { saldo: number }[]): number =>
    documentos.reduce((sum, d) => sum + d.saldo, 0);
  const cargoDe = (
    documentos: { cargosPorConcepto: Record<string, number> }[],
  ): number =>
    documentos.reduce(
      (sum, d) => sum + (d.cargosPorConcepto[conceptoId] ?? 0),
      0,
    );

  const granTotalSaldo = saldoDe(grupos.flatMap((g) => g.documentos));
  const granTotalCargo = cargoDe(grupos.flatMap((g) => g.documentos));

  if (tipo === 'resumido') {
    const columnas = [
      'Inmueble',
      'Titular',
      'Celular',
      'Saldo',
      nombreCargo,
      '% Participación',
    ];
    const filas = grupos.map((g) => {
      const saldo = saldoDe(g.documentos);
      const cargo = cargoDe(g.documentos);
      return [
        g.inmuebleCodigo,
        g.titular ?? '—',
        g.celular ?? '—',
        formatoPeso(saldo),
        formatoPeso(cargo),
        formatoPorcentaje(cargo, saldo),
      ];
    });
    filas.push([
      'GRAN TOTAL',
      '',
      '',
      formatoPeso(granTotalSaldo),
      formatoPeso(granTotalCargo),
      formatoPorcentaje(granTotalCargo, granTotalSaldo),
    ]);

    escribirTabla(ctx, columnas, filas, {
      columnasNumericas: 3,
      anchosRelativos: [0.8, 1.8, 1.1, 1.1, 1.1, 1.1],
    });
  } else {
    const columnas = [
      'Inmueble',
      'Titular',
      'Fecha',
      'Tipo',
      'Número',
      'Vence',
      'Saldo',
      nombreCargo,
      '% Participación',
    ];
    const filas = grupos.flatMap((g) =>
      g.documentos.map((d) => {
        const cargo = d.cargosPorConcepto[conceptoId] ?? 0;
        return [
          g.inmuebleCodigo,
          g.titular ?? '—',
          formatoFecha(d.fecha),
          d.tipo,
          d.numeroCompleto,
          d.vence ? formatoFecha(d.vence) : '—',
          formatoPeso(d.saldo),
          formatoPeso(cargo),
          formatoPorcentaje(cargo, d.saldo),
        ];
      }),
    );
    filas.push([
      'GRAN TOTAL',
      '',
      '',
      '',
      '',
      '',
      formatoPeso(granTotalSaldo),
      formatoPeso(granTotalCargo),
      formatoPorcentaje(granTotalCargo, granTotalSaldo),
    ]);

    escribirTabla(ctx, columnas, filas, {
      columnasNumericas: 3,
      anchosRelativos: [0.7, 1.4, 0.8, 0.6, 1, 0.8, 1, 1.1, 1.1],
    });
  }

  return ctx.doc.save();
}
