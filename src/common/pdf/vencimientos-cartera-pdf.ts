import { createElement, type ReactElement } from 'react';
import { formatoFecha, formatoPesoSinSimbolo } from './pdf-helpers';
import { EncabezadoInforme } from './react/encabezado-informe';
import {
  construirPdfTablaAgrupada,
  numeroSinTipo,
  type ColumnaTablaAgrupada,
  type LineaTablaAgrupada,
} from './react/tabla-agrupada';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  FilaVencimientoCartera,
  RangoVencimiento,
  RespuestaVencimientosCartera,
} from '../../contracts';

const RANGOS: { rango: RangoVencimiento; etiqueta: string }[] = [
  { rango: 'sinVencer', etiqueta: 'Sin Vencer' },
  { rango: 'dias_1_30', etiqueta: '1-30' },
  { rango: 'dias_31_60', etiqueta: '31-60' },
  { rango: 'dias_61_90', etiqueta: '61-90' },
  { rango: 'dias_91_120', etiqueta: '91-120' },
  { rango: 'dias_121_180', etiqueta: '121-180' },
  { rango: 'dias_181_360', etiqueta: '181-360' },
  { rango: 'dias_361_720', etiqueta: '361-720' },
  { rango: 'dias_720_mas', etiqueta: '+720' },
];

const COLUMNAS_RANGO: ColumnaTablaAgrupada[] = RANGOS.map((r) => ({
  titulo: r.etiqueta,
  peso: 0.9,
  numerica: true,
}));

const ESTADO_INMUEBLE_LABELS = { activo: 'Activos', inactivo: 'Inactivos' };
const ESTADO_CARTERA_LABELS = {
  vigente: 'Vigente',
  juridico: 'En Jurídico',
  dificil_recaudo: 'Difícil Recaudo',
};

export interface FiltroPdfVencimientos {
  inmuebleId?: string;
  rango?: RangoVencimiento;
  /** Already applied server-side by `VencimientosCarteraService` — only
   *  used here to name the filter in the subtitle. */
  estadoInmueble?: 'activo' | 'inactivo';
  /** Same as `estadoInmueble`: applied upstream, named in the subtitle. */
  estadoCartera?: 'vigente' | 'juridico' | 'dificil_recaudo';
  tipo?: 'resumido' | 'detallado';
}

/** Narrows `reporte` to one inmueble and/or one aging bucket — the same
 *  on-screen filters `vencimientos-cartera.tsx` applies client-side, mirrored
 *  here so the PDF (rendered server-side, unlike the Excel export) reflects
 *  whichever filters were active instead of always printing everything. */
function filtrarReporte(
  reporte: RespuestaVencimientosCartera,
  filtro: FiltroPdfVencimientos,
): RespuestaVencimientosCartera {
  if (!filtro.inmuebleId && !filtro.rango) return reporte;

  const filas = reporte.filas.filter(
    (f) =>
      (!filtro.inmuebleId || f.inmuebleId === filtro.inmuebleId) &&
      (!filtro.rango || f.rango === filtro.rango),
  );
  const rangos = RANGOS.map((r) => ({
    rango: r.rango,
    etiqueta:
      reporte.rangos.find((existente) => existente.rango === r.rango)
        ?.etiqueta ?? r.etiqueta,
    valor: filas
      .filter((f) => f.rango === r.rango)
      .reduce((sum, f) => sum + f.saldo, 0),
  }));
  const totalCartera = filas.reduce((sum, f) => sum + f.saldo, 0);

  return { ...reporte, filas, rangos, totalCartera };
}

/** The bucket columns' cells for a set of rows: each bucket's summed saldo. */
function montosPorRango(filas: FilaVencimientoCartera[]): string[] {
  return RANGOS.map((r) =>
    formatoPesoSinSimbolo(
      filas
        .filter((f) => f.rango === r.rango)
        .reduce((sum, f) => sum + f.saldo, 0),
    ),
  );
}

/** Rows grouped by inmueble, keeping the service's own order (código, then
 *  fecha). */
function agruparPorInmueble(
  filas: FilaVencimientoCartera[],
): FilaVencimientoCartera[][] {
  const grupos = new Map<string, FilaVencimientoCartera[]>();
  for (const f of filas) {
    const lista = grupos.get(f.inmuebleId) ?? [];
    lista.push(f);
    grupos.set(f.inmuebleId, lista);
  }
  return [...grupos.values()];
}

/**
 * Generates the Vencimientos de Cartera PDF in one of two shapes, the same
 * split Cartera por Conceptos offers (product request, 2026-09-28):
 *
 * - "detallado" (default): one row per pending document, grouped under an
 *   "Inmueble — Propietario — Celular" header with a per-inmueble subtotal,
 *   its saldo repeated under whichever aging-bucket column it falls into.
 * - "resumido": one row per inmueble — its total saldo split across the
 *   aging buckets.
 *
 * Both close with a TOTALES row, print amounts without "$", and share
 * `construirPdfTablaAgrupada`'s fonts and manual pagination. `filtro`
 * narrows to one inmueble and/or one aging bucket, matching the screen; the
 * unit/collection-status filters were already applied by the service and
 * are only named in the subtitle here.
 */
export async function generarPdfVencimientosCartera(
  reporteCompleto: RespuestaVencimientosCartera,
  copropiedad: CopropiedadDocument,
  filtro: FiltroPdfVencimientos = {},
): Promise<Buffer> {
  const reporte = filtrarReporte(reporteCompleto, filtro);
  const tipo = filtro.tipo ?? 'detallado';

  const partesSubtitulo = [
    tipo === 'resumido' ? 'Resumido' : 'Detallado',
    `Corte al ${formatoFecha(reporte.fechaCorte)}`,
    filtro.estadoCartera
      ? `Estado Cartera: ${ESTADO_CARTERA_LABELS[filtro.estadoCartera]}`
      : null,
  ].filter((p): p is string => p !== null);
  // The unit-status filter gets its own line under the title (product
  // request, 2026-09-29), same as Cartera por Conceptos.
  const lineaInmuebles = filtro.estadoInmueble
    ? `Inmuebles: ${ESTADO_INMUEBLE_LABELS[filtro.estadoInmueble]}`
    : null;
  // Computed once, outside any page — every page's footer shows the same
  // instant (stamped next to "Generado con", not in the masthead).
  const fechaGeneracion = new Date();
  const crearEncabezado = (): ReactElement =>
    createElement(EncabezadoInforme, {
      copropiedad,
      titulo: 'VENCIMIENTOS DE CARTERA',
      subtitulo: [
        partesSubtitulo.join(' — '),
        ...(lineaInmuebles ? [lineaInmuebles] : []),
      ],
    });

  const grupos = agruparPorInmueble(reporte.filas);
  const totales = {
    etiqueta: 'TOTALES',
    valores: [
      formatoPesoSinSimbolo(reporte.totalCartera),
      ...RANGOS.map((r) =>
        formatoPesoSinSimbolo(
          reporte.rangos.find((x) => x.rango === r.rango)?.valor ?? 0,
        ),
      ),
    ],
  };

  if (tipo === 'resumido') {
    const lineas: LineaTablaAgrupada[][] = grupos.map((filas, i) => {
      const f = filas[0];
      return [
        {
          clase: 'documento',
          par: i % 2 === 1,
          celdas: [
            f.inmuebleCodigo,
            f.propietario ?? '—',
            f.celular ?? '—',
            formatoPesoSinSimbolo(filas.reduce((s, x) => s + x.saldo, 0)),
            ...montosPorRango(filas),
          ],
        },
      ];
    });
    return construirPdfTablaAgrupada(
      crearEncabezado,
      [
        { titulo: 'Inmueble', peso: 0.8, numerica: false },
        { titulo: 'Propietario', peso: 2, numerica: false },
        { titulo: 'Celular', peso: 1, numerica: false },
        { titulo: 'Saldo', peso: 1, numerica: true },
        ...COLUMNAS_RANGO,
      ],
      lineas,
      totales,
      fechaGeneracion,
    );
  }

  const lineas: LineaTablaAgrupada[][] = grupos.map((filas) => {
    const f = filas[0];
    return [
      {
        clase: 'grupo',
        texto: `Inmueble ${f.inmuebleCodigo} — ${f.propietario ?? 'Sin propietario'} — Celular: ${f.celular ?? '—'}`,
      },
      ...filas.map((d, i): LineaTablaAgrupada => ({
        clase: 'documento',
        par: i % 2 === 1,
        celdas: [
          d.tipo,
          numeroSinTipo(d.numeroCompleto),
          formatoFecha(d.fecha),
          formatoFecha(d.vence),
          String(d.diasMora),
          formatoPesoSinSimbolo(d.saldo),
          ...RANGOS.map((r) =>
            d.rango === r.rango ? formatoPesoSinSimbolo(d.saldo) : '',
          ),
        ],
      })),
      {
        clase: 'subtotal',
        etiqueta: `Total inmueble ${f.inmuebleCodigo}`,
        valores: [
          '',
          formatoPesoSinSimbolo(filas.reduce((s, x) => s + x.saldo, 0)),
          ...montosPorRango(filas),
        ],
      },
    ];
  });
  return construirPdfTablaAgrupada(
    crearEncabezado,
    [
      { titulo: 'Tipo', peso: 0.5, numerica: false },
      { titulo: 'Número', peso: 0.9, numerica: false },
      { titulo: 'Fecha', peso: 0.8, numerica: false },
      { titulo: 'Vence', peso: 0.8, numerica: false },
      { titulo: 'Días', peso: 0.5, numerica: true },
      { titulo: 'Saldo', peso: 1, numerica: true },
      ...COLUMNAS_RANGO,
    ],
    lineas,
    { ...totales, valores: ['', ...totales.valores] },
    fechaGeneracion,
  );
}
