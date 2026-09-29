import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha, formatoPesoSinSimbolo } from './pdf-helpers';
import {
  reporteDocumento,
  reporteDocumentoMultiPagina,
  renderizarPdf,
} from './react/document';
import { EncabezadoInforme } from './react/encabezado-informe';
import { Tabla } from './react/tabla';
import { CreditoWebsaco } from './react/credito-websaco';
import {
  construirPdfTablaAgrupada,
  numeroSinTipo,
  type ColumnaTablaAgrupada,
  type LineaTablaAgrupada,
} from './react/tabla-agrupada';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaCarteraPorConceptos } from '../../contracts';

/** Up to 8 concepts get their own column — narrower than Cartera por
 *  Inmueble's 11, since this report also carries an Inmueble column
 *  (detallado) that one doesn't. Anything beyond is summed into one final
 *  "Otros Cargos" column. Only used in the "todos los conceptos" layout —
 *  the "un solo concepto" layout never has more than its own one column. */
const MAX_CARGOS_INDIVIDUALES = 8;

/** Rows per page, computed by hand rather than left to react-pdf's
 *  automatic `wrap` pagination — same reasoning and same approach as
 *  `vencimientos-cartera-pdf.ts`'s own `FILAS_POR_PAGINA`: a masthead +
 *  table header repeated via `fixed` doesn't reserve its own height
 *  against react-pdf's row-fitting estimate, so manual per-page `<Page>`
 *  elements (`reporteDocumentoMultiPagina`) are the only reliable way to
 *  guarantee the masthead, table header AND `CreditoWebsaco` footer all
 *  repeat correctly once a report runs past one page.
 *
 *  Measured off real renders (2026-09-29), not estimated: a 10pt row is
 *  ~12.5pt tall, and 32 rows plus the GRAN TOTAL row, a two-line subtitle
 *  and the footer are the most one landscape page holds — 33 already spills
 *  the total onto a second page. The previous 24 left a third of every page
 *  empty (reported). */
const FILAS_POR_PAGINA_RESUMIDO = 32;

const ESTADO_INMUEBLE_LABELS = { activo: 'Activos', inactivo: 'Inactivos' };

const ESTADO_LABELS: Record<
  'vigente' | 'juridico' | 'dificil_recaudo',
  string
> = {
  vigente: 'Vigente',
  dificil_recaudo: 'Difícil Recaudo',
  juridico: 'En Jurídico',
};

const styles = StyleSheet.create({
  sinDatos: {
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
});

/** "Inmueble <código> — <propietario> — Celular: <celular>", the group
 *  header line of the "detallado" layout. */
function tituloGrupo(g: {
  inmuebleCodigo: string;
  titular: string | null;
  celular: string | null;
}): string {
  return `Inmueble ${g.inmuebleCodigo} — ${g.titular ?? 'Sin propietario'} — Celular: ${g.celular ?? '—'}`;
}

/** Sums every document's `cargosPorConcepto` into one per-concept map. */
function sumarCargos(
  documentos: { cargosPorConcepto: Record<string, number> }[],
): Record<string, number> {
  const total: Record<string, number> = {};
  for (const d of documentos) {
    for (const [conceptoId, monto] of Object.entries(d.cargosPorConcepto)) {
      total[conceptoId] = (total[conceptoId] ?? 0) + monto;
    }
  }
  return total;
}

/** Tipo / Número / Fecha / Vence / Saldo — the fixed leading columns both
 *  "detallado" layouts share, ahead of their own cargo columns. */
const COLUMNAS_FIJAS_DETALLADO: ColumnaTablaAgrupada[] = [
  { titulo: 'Tipo', peso: 0.5, numerica: false },
  { titulo: 'Número', peso: 0.9, numerica: false },
  { titulo: 'Fecha', peso: 0.8, numerica: false },
  { titulo: 'Vence', peso: 0.8, numerica: false },
  { titulo: 'Saldo', peso: 1, numerica: true },
];

/** The fixed leading cells of one document row, matching
 *  `COLUMNAS_FIJAS_DETALLADO`. */
function celdasFijasDetallado(d: {
  tipo: string;
  numeroCompleto: string;
  fecha: string;
  vence: string | null;
  saldo: number;
}): string[] {
  return [
    d.tipo,
    numeroSinTipo(d.numeroCompleto),
    formatoFecha(d.fecha),
    d.vence ? formatoFecha(d.vence) : '—',
    formatoPesoSinSimbolo(d.saldo),
  ];
}

/** cargo/saldo * 100, or "—" when there is nothing to divide by (never
 *  happens for a real row — a document with saldo <= 0 is excluded
 *  upstream — but a totals row is a derived sum worth guarding on its own). */
function formatoPorcentaje(cargo: number, saldo: number): string {
  return saldo > 0 ? `${((cargo / saldo) * 100).toFixed(1)}%` : '—';
}

function agruparEnPaginas<T>(items: T[], porPagina: number): T[][] {
  if (items.length === 0) return [[]];
  const paginas: T[][] = [];
  for (let i = 0; i < items.length; i += porPagina) {
    paginas.push(items.slice(i, i + porPagina));
  }
  return paginas;
}

/**
 * Splits `filas` into page-sized chunks and builds one multi-page PDF, each
 * page carrying its own masthead (`crearEncabezado`), its own full `Tabla`
 * (same `columnas`/widths every page — only the last page gets
 * `filaTotales`), and its own `CreditoWebsaco` — see `FILAS_POR_PAGINA_*`'s
 * own docblock for why this can't be react-pdf's automatic `wrap` instead.
 */
function construirPdfPaginado(
  crearEncabezado: () => ReactElement,
  filas: string[][],
  filasPorPagina: number,
  tabla: {
    columnas: string[];
    anchosRelativos: number[];
    columnasNumericas: number;
    fontSize?: number;
    filaTotales: string[];
  },
  fechaGeneracion: Date,
): Promise<Buffer> {
  const bloques = agruparEnPaginas(filas, filasPorPagina);
  const paginas = bloques.map((bloque, i) =>
    createElement(
      View,
      null,
      crearEncabezado(),
      createElement(Tabla, {
        striped: true,
        columnas: tabla.columnas,
        filas: bloque,
        columnasNumericas: tabla.columnasNumericas,
        anchosRelativos: tabla.anchosRelativos,
        fontSize: tabla.fontSize,
        filaTotales: i === bloques.length - 1 ? tabla.filaTotales : undefined,
      }),
      createElement(CreditoWebsaco, { fechaGeneracion }),
    ),
  );
  return renderizarPdf(
    reporteDocumentoMultiPagina(paginas, { orientacion: 'horizontal' }),
  );
}

/**
 * Generates a real PDF for Cartera por Conceptos, in one of two shapes:
 *
 * - Every concept at once (`conceptoId` omitted): the "Por Inmueble" tab's
 *   own layout — one column per concept (capped, see `MAX_CARGOS_INDIVIDUALES`),
 *   "resumido" (one row per inmueble) or "detallado" (one row per document,
 *   grouped under an inmueble header with per-group subtotals — see
 *   `construirPdfTablaAgrupada`).
 * - One single concept (`conceptoId` given): the "Por Concepto" tab's own
 *   layout — filtered to documents carrying that one charge, with a single
 *   named cargo column plus a "% Participación" column (cargo/saldo), same
 *   resumido/detallado split.
 * - One single collection status (`estado` given): the "Por Estado" tab's
 *   own layout — the same "Por Inmueble" one-column-per-concept table,
 *   filtered down to inmuebles carrying that `estadoCartera`.
 *
 * React-pdf, built directly (no pdf-lib version kept behind a `?version=`
 * toggle — direct cutover is the settled approach for this migration).
 */
export async function generarPdfCarteraPorConceptos(
  reporte: RespuestaCarteraPorConceptos,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
  tipo: 'resumido' | 'detallado',
  conceptoId?: string,
  estado?: 'vigente' | 'juridico' | 'dificil_recaudo',
  /** Already applied by the service (`ConsultarCarteraPorConceptosDto`) —
   *  only named here, as its own "Inmuebles: …" line under the title. */
  estadoInmueble?: 'activo' | 'inactivo',
): Promise<Buffer> {
  const lineaInmuebles = estadoInmueble
    ? `Inmuebles: ${ESTADO_INMUEBLE_LABELS[estadoInmueble]}`
    : null;
  if (estado) {
    const filtrado: RespuestaCarteraPorConceptos = {
      ...reporte,
      grupos: reporte.grupos.filter((g) => g.estadoCartera === estado),
    };
    return generarPorInmueble(
      filtrado,
      copropiedad,
      fechaCorte,
      tipo,
      lineaInmuebles,
      ESTADO_LABELS[estado],
    );
  }
  return conceptoId
    ? generarPorConcepto(
        reporte,
        copropiedad,
        fechaCorte,
        tipo,
        conceptoId,
        lineaInmuebles,
      )
    : generarPorInmueble(
        reporte,
        copropiedad,
        fechaCorte,
        tipo,
        lineaInmuebles,
      );
}

async function generarPorInmueble(
  reporte: RespuestaCarteraPorConceptos,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
  tipo: 'resumido' | 'detallado',
  lineaInmuebles: string | null,
  estadoLabel?: string,
): Promise<Buffer> {
  // Computed once, outside any page — `EncabezadoInforme`'s own docblock:
  // every page of one report must show the exact same instant, never one
  // that drifts by however long that page took to render.
  const fechaGeneracion = new Date();
  const crearEncabezado = (): ReactElement =>
    createElement(EncabezadoInforme, {
      copropiedad,
      titulo: 'CARTERA POR CONCEPTOS',
      subtitulo: [
        `${tipo === 'resumido' ? 'Resumido' : 'Detallado'}${estadoLabel ? '' : ' Inmueble'} — Corte al ${formatoFecha(fechaCorte)}${estadoLabel ? ` — Estado: ${estadoLabel}` : ''}`,
        ...(lineaInmuebles ? [lineaInmuebles] : []),
      ],
    });

  if (reporte.grupos.length === 0) {
    return renderizarPdf(
      reporteDocumento(
        createElement(
          View,
          null,
          crearEncabezado(),
          createElement(
            Text,
            { style: styles.sinDatos },
            'No hay cartera pendiente en esta copropiedad.',
          ),
          createElement(CreditoWebsaco, { fechaGeneracion }),
        ),
        { orientacion: 'horizontal' },
      ),
    );
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
      formatoPesoSinSimbolo(cargosPorConcepto[c.conceptoId] ?? 0),
    ),
    ...(hayOtros
      ? [
          formatoPesoSinSimbolo(
            sumaCargos(cargosPorConcepto, conceptosAgrupados),
          ),
        ]
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
    const columnas = ['Inmueble', 'Celular', 'Saldo', ...columnasCargos];
    const anchosRelativos = [0.8, 1, 1, ...columnasCargos.map(() => 1.1)];

    const filas = reporte.grupos.map((g) => {
      const cargosGrupo: Record<string, number> = {};
      for (const d of g.documentos) {
        for (const [conceptoId, monto] of Object.entries(d.cargosPorConcepto)) {
          cargosGrupo[conceptoId] = (cargosGrupo[conceptoId] ?? 0) + monto;
        }
      }
      return [
        g.inmuebleCodigo,
        g.celular ?? '—',
        formatoPesoSinSimbolo(g.saldoTotal),
        ...cargosDe(cargosGrupo),
      ];
    });

    return construirPdfPaginado(
      crearEncabezado,
      filas,
      FILAS_POR_PAGINA_RESUMIDO,
      {
        columnas,
        anchosRelativos,
        columnasNumericas: 1 + columnasCargos.length,
        filaTotales: [
          'GRAN TOTAL',
          '',
          formatoPesoSinSimbolo(granTotalSaldo),
          ...cargosDe(granTotalCargos),
        ],
      },
      fechaGeneracion,
    );
  }

  const lineasPorGrupo: LineaTablaAgrupada[][] = reporte.grupos.map((g) => [
    { clase: 'grupo' as const, texto: tituloGrupo(g) },
    ...g.documentos.map((d, i) => ({
      clase: 'documento' as const,
      par: i % 2 === 1,
      celdas: [...celdasFijasDetallado(d), ...cargosDe(d.cargosPorConcepto)],
    })),
    {
      clase: 'subtotal' as const,
      etiqueta: `Total inmueble ${g.inmuebleCodigo}`,
      valores: [
        formatoPesoSinSimbolo(g.saldoTotal),
        ...cargosDe(sumarCargos(g.documentos)),
      ],
    },
  ]);

  return construirPdfTablaAgrupada(
    crearEncabezado,
    [
      ...COLUMNAS_FIJAS_DETALLADO,
      ...columnasCargos.map((titulo) => ({
        titulo,
        peso: 1.1,
        numerica: true,
      })),
    ],
    lineasPorGrupo,
    {
      etiqueta: 'TOTALES',
      valores: [
        formatoPesoSinSimbolo(granTotalSaldo),
        ...cargosDe(granTotalCargos),
      ],
    },
    fechaGeneracion,
  );
}

async function generarPorConcepto(
  reporte: RespuestaCarteraPorConceptos,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
  tipo: 'resumido' | 'detallado',
  conceptoId: string,
  lineaInmuebles: string | null,
): Promise<Buffer> {
  const nombreCargo =
    reporte.conceptos.find((c) => c.conceptoId === conceptoId)?.nombre ??
    'Cargo';

  // Same "computed once outside any page" reasoning as `generarPorInmueble`.
  const fechaGeneracion = new Date();
  const crearEncabezado = (): ReactElement =>
    createElement(EncabezadoInforme, {
      copropiedad,
      titulo: 'CARTERA POR CONCEPTOS',
      subtitulo: [
        `${tipo === 'resumido' ? 'Resumido' : 'Detallado'} — ${nombreCargo} — Corte al ${formatoFecha(fechaCorte)}`,
        ...(lineaInmuebles ? [lineaInmuebles] : []),
      ],
    });

  const grupos = reporte.grupos
    .map((g) => ({
      ...g,
      documentos: g.documentos.filter(
        (d) => (d.cargosPorConcepto[conceptoId] ?? 0) > 0,
      ),
    }))
    .filter((g) => g.documentos.length > 0);

  if (grupos.length === 0) {
    return renderizarPdf(
      reporteDocumento(
        createElement(
          View,
          null,
          crearEncabezado(),
          createElement(
            Text,
            { style: styles.sinDatos },
            'No hay cartera pendiente para este cargo en esta copropiedad.',
          ),
          createElement(CreditoWebsaco, { fechaGeneracion }),
        ),
        { orientacion: 'horizontal' },
      ),
    );
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
        g.celular ?? '—',
        formatoPesoSinSimbolo(saldo),
        formatoPesoSinSimbolo(cargo),
        formatoPorcentaje(cargo, saldo),
      ];
    });

    return construirPdfPaginado(
      crearEncabezado,
      filas,
      FILAS_POR_PAGINA_RESUMIDO,
      {
        columnas,
        anchosRelativos: [0.8, 1.1, 1.1, 1.1, 1.1],
        columnasNumericas: 3,
        filaTotales: [
          'GRAN TOTAL',
          '',
          formatoPesoSinSimbolo(granTotalSaldo),
          formatoPesoSinSimbolo(granTotalCargo),
          formatoPorcentaje(granTotalCargo, granTotalSaldo),
        ],
      },
      fechaGeneracion,
    );
  }

  const lineasPorGrupo: LineaTablaAgrupada[][] = grupos.map((g) => {
    const saldoGrupo = saldoDe(g.documentos);
    const cargoGrupo = cargoDe(g.documentos);
    return [
      { clase: 'grupo' as const, texto: tituloGrupo(g) },
      ...g.documentos.map((d, i) => {
        const cargo = d.cargosPorConcepto[conceptoId] ?? 0;
        return {
          clase: 'documento' as const,
          par: i % 2 === 1,
          celdas: [
            ...celdasFijasDetallado(d),
            formatoPesoSinSimbolo(cargo),
            formatoPorcentaje(cargo, d.saldo),
          ],
        };
      }),
      {
        clase: 'subtotal' as const,
        etiqueta: `Total inmueble ${g.inmuebleCodigo}`,
        valores: [
          formatoPesoSinSimbolo(saldoGrupo),
          formatoPesoSinSimbolo(cargoGrupo),
          formatoPorcentaje(cargoGrupo, saldoGrupo),
        ],
      },
    ];
  });

  return construirPdfTablaAgrupada(
    crearEncabezado,
    [
      ...COLUMNAS_FIJAS_DETALLADO,
      { titulo: nombreCargo, peso: 1.1, numerica: true },
      { titulo: '% Participación', peso: 1.1, numerica: true },
    ],
    lineasPorGrupo,
    {
      etiqueta: 'TOTALES',
      valores: [
        formatoPesoSinSimbolo(granTotalSaldo),
        formatoPesoSinSimbolo(granTotalCargo),
        formatoPorcentaje(granTotalCargo, granTotalSaldo),
      ],
    },
    fechaGeneracion,
  );
}
