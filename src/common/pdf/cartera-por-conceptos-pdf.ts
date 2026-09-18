import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import {
  reporteDocumento,
  reporteDocumentoMultiPagina,
  renderizarPdf,
} from './react/document';
import { EncabezadoInforme } from './react/encabezado-informe';
import { Tabla } from './react/tabla';
import { CreditoWebsaco } from './react/credito-websaco';
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
 *  612pt (landscape height) − 48pt (24pt top+bottom margin, see
 *  `document.ts`) ≈ 564pt usable. Budget: ~80pt masthead
 *  (`EncabezadoInforme`'s banner + info row + rule) + ~18pt table header
 *  (10pt text × ~1.2 line-height + 3pt padding + 3pt margin) + ~24pt
 *  footer (`CreditoWebsaco`, in-flow) ≈ 442pt left for rows, ÷ ~14pt/row
 *  (10pt text + 2pt vertical padding) ≈ 31 — kept well under that (24) for
 *  headroom against line-height estimate error and any cell wrapping to a
 *  second line at these column widths, since there's no way to render and
 *  visually verify the actual output from here. */
const FILAS_POR_PAGINA_RESUMIDO = 24;
/** Same budget, `fontSize: 8` table (see the "detallado" `Tabla` calls) —
 *  a shorter header (~15.6pt) and shorter rows (~12pt) fit a few more,
 *  kept at 28 for the same headroom reasoning as the resumido constant. */
const FILAS_POR_PAGINA_DETALLADO = 28;

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
      createElement(CreditoWebsaco, {}),
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
 *   "resumido" (one row per inmueble) or "detallado" (one row per document).
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
): Promise<Buffer> {
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
      ESTADO_LABELS[estado],
    );
  }
  return conceptoId
    ? generarPorConcepto(reporte, copropiedad, fechaCorte, tipo, conceptoId)
    : generarPorInmueble(reporte, copropiedad, fechaCorte, tipo);
}

async function generarPorInmueble(
  reporte: RespuestaCarteraPorConceptos,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
  tipo: 'resumido' | 'detallado',
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
      subtitulo: `${tipo === 'resumido' ? 'Resumido' : 'Detallado'} — Corte al ${formatoFecha(fechaCorte)}${estadoLabel ? ` — Estado: ${estadoLabel}` : ''}`,
      fechaGeneracion,
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
          createElement(CreditoWebsaco, {}),
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
        formatoPeso(g.saldoTotal),
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
          formatoPeso(granTotalSaldo),
          ...cargosDe(granTotalCargos),
        ],
      },
    );
  }

  const columnas = [
    'Inmueble',
    'Número',
    'Fecha',
    'Vence',
    'Saldo',
    ...columnasCargos,
  ];
  const anchosRelativos = [
    0.7,
    1,
    0.8,
    0.8,
    1,
    ...columnasCargos.map(() => 1.1),
  ];

  const filas = reporte.grupos.flatMap((g) =>
    g.documentos.map((d) => [
      g.inmuebleCodigo,
      d.numeroCompleto,
      formatoFecha(d.fecha),
      d.vence ? formatoFecha(d.vence) : '—',
      formatoPeso(d.saldo),
      ...cargosDe(d.cargosPorConcepto),
    ]),
  );

  return construirPdfPaginado(
    crearEncabezado,
    filas,
    FILAS_POR_PAGINA_DETALLADO,
    {
      columnas,
      anchosRelativos,
      columnasNumericas: 1 + columnasCargos.length,
      // Detallado carries two more fixed columns than resumido on top of
      // the same concept columns — smaller text keeps every cell readable
      // instead of overflowing or wrapping into its neighbor.
      fontSize: 8,
      filaTotales: [
        'GRAN TOTAL',
        '',
        '',
        formatoPeso(granTotalSaldo),
        ...cargosDe(granTotalCargos),
      ],
    },
  );
}

async function generarPorConcepto(
  reporte: RespuestaCarteraPorConceptos,
  copropiedad: CopropiedadDocument,
  fechaCorte: string,
  tipo: 'resumido' | 'detallado',
  conceptoId: string,
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
      subtitulo: `${tipo === 'resumido' ? 'Resumido' : 'Detallado'} — ${nombreCargo} — Corte al ${formatoFecha(fechaCorte)}`,
      fechaGeneracion,
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
          createElement(CreditoWebsaco, {}),
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
        formatoPeso(saldo),
        formatoPeso(cargo),
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
          formatoPeso(granTotalSaldo),
          formatoPeso(granTotalCargo),
          formatoPorcentaje(granTotalCargo, granTotalSaldo),
        ],
      },
    );
  }

  const columnas = [
    'Inmueble',
    'Número',
    'Fecha',
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
        d.numeroCompleto,
        formatoFecha(d.fecha),
        d.vence ? formatoFecha(d.vence) : '—',
        formatoPeso(d.saldo),
        formatoPeso(cargo),
        formatoPorcentaje(cargo, d.saldo),
      ];
    }),
  );

  return construirPdfPaginado(
    crearEncabezado,
    filas,
    FILAS_POR_PAGINA_DETALLADO,
    {
      columnas,
      anchosRelativos: [0.7, 1, 0.8, 0.8, 1, 1.1, 1.1],
      columnasNumericas: 3,
      // Same reasoning as the "Por Inmueble" layout's own detallado
      // branch — two extra fixed columns need the smaller size to stay
      // readable without overflowing.
      fontSize: 8,
      filaTotales: [
        'GRAN TOTAL',
        '',
        '',
        formatoPeso(granTotalSaldo),
        formatoPeso(granTotalCargo),
        formatoPorcentaje(granTotalCargo, granTotalSaldo),
      ],
    },
  );
}
