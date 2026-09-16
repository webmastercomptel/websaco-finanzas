import { createElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import type { Style } from '@react-pdf/types';
import { formatoFecha } from './pdf-helpers';
import {
  reporteDocumentoMultiPagina,
  renderizarPdf,
  CONTENT_WIDTH_PT_HORIZONTAL,
} from './react/document';
import { CreditoWebsaco } from './react/credito-websaco';
import { EncabezadoInforme } from './react/encabezado-informe';
import { FONDO_ZEBRA } from './react/paleta';
import { truncarTexto } from './react/text-measure';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  MovimientoContable,
  RespuestaMovimientoContable,
} from '../../contracts';

interface FiltroMovimientoContable {
  tipo?: MovimientoContable['tipoDocumento'];
  inmuebleCodigo?: string;
  numero?: string;
}

/** Same narrowing the on-screen table applies client-side
 *  (`movimiento-contable.tsx`'s own `filas` filter) — applied here too so
 *  the printed PDF matches what's actually on screen instead of always
 *  dumping the whole period (bug real reportado: el PDF ignoraba tipo,
 *  inmueble y número). */
function filtrarReporte(
  reporteCompleto: RespuestaMovimientoContable,
  filtro: FiltroMovimientoContable,
): RespuestaMovimientoContable {
  const numeroFiltro = filtro.numero?.trim().toLowerCase();
  const movimientos = reporteCompleto.movimientos.filter((m) => {
    if (filtro.tipo && m.tipoDocumento !== filtro.tipo) return false;
    if (filtro.inmuebleCodigo && m.inmuebleCodigo !== filtro.inmuebleCodigo)
      return false;
    if (numeroFiltro && !m.numeroDocumento.toLowerCase().includes(numeroFiltro))
      return false;
    return true;
  });
  return { movimientos };
}

interface ColumnaTabla {
  titulo: string;
  peso: number;
  numerica: boolean;
}

const COLUMNAS: ColumnaTabla[] = [
  { titulo: 'Tipo', peso: 0.5, numerica: false },
  { titulo: 'Número', peso: 1.1, numerica: false },
  { titulo: 'Código', peso: 0.7, numerica: false },
  { titulo: 'Nombre de la Cuenta', peso: 1.9, numerica: false },
  { titulo: 'Inmueble', peso: 0.8, numerica: false },
  { titulo: 'Fecha', peso: 0.9, numerica: false },
  { titulo: 'Débito', peso: 1.0, numerica: true },
  { titulo: 'Crédito', peso: 1.0, numerica: true },
  { titulo: 'Tercero', peso: 1.0, numerica: false },
  { titulo: 'Centro Costo', peso: 1.0, numerica: false },
  { titulo: 'Flujo Caja', peso: 1.0, numerica: false },
  { titulo: 'Base Gravable', peso: 1.0, numerica: true },
];
const PESO_TOTAL = COLUMNAS.reduce((acc, c) => acc + c.peso, 0);
const ANCHOS_PT = COLUMNAS.map(
  (c) => (c.peso / PESO_TOTAL) * CONTENT_WIDTH_PT_HORIZONTAL,
);

const FUENTE_DATOS = 6.5;

/** Same reasoning as `vencimientos-cartera-pdf.ts`'s own constant — manual
 *  per-page pagination instead of react-pdf's automatic `wrap`. */
const FILAS_POR_PAGINA = 38;

function formatoPesoCompacto(valor: number): string {
  return valor.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

/** One flattened accounting line — mirrors the frontend's own `FilaLinea` in
 *  `movimiento-contable.tsx`: the printed table needs the same tipo/número
 *  ascending order and per-document subtotal bar the screen shows, not the
 *  movimientos-grouped shape `RespuestaMovimientoContable` returns. */
interface FilaLinea {
  tipoDocumento: string;
  numeroDocumento: string;
  cuenta: string;
  nombreCuenta: string;
  inmuebleCodigo: string | null;
  fecha: string;
  debito: number | null;
  credito: number | null;
  tercero: string | null;
  centroCosto: string | null;
  flujoCaja: string | null;
  baseGravable: number | null;
}

/** Same ascending tipo-then-número ordering the on-screen table uses
 *  (`compararPorTipoYNumero` in `movimiento-contable.tsx`) — `numeric: true`
 *  compares "RC-10" after "RC-9", not before as a plain string compare
 *  would. `sort` is stable, so lines already grouped by document stay
 *  grouped after this. */
const collator = new Intl.Collator('es', {
  numeric: true,
  sensitivity: 'base',
});
function compararPorTipoYNumero(a: FilaLinea, b: FilaLinea): number {
  return (
    collator.compare(a.tipoDocumento, b.tipoDocumento) ||
    collator.compare(a.numeroDocumento, b.numeroDocumento)
  );
}

function aFilas(reporte: RespuestaMovimientoContable): FilaLinea[] {
  const filas: FilaLinea[] = [];
  for (const m of reporte.movimientos) {
    for (const l of m.lineas) {
      filas.push({
        tipoDocumento: m.tipoDocumento,
        numeroDocumento: m.numeroDocumento,
        cuenta: l.cuenta,
        nombreCuenta: l.nombreCuenta,
        inmuebleCodigo: m.inmuebleCodigo,
        fecha: m.fecha,
        debito: l.tipo === 'debito' ? l.monto : null,
        credito: l.tipo === 'credito' ? l.monto : null,
        tercero: l.tercero,
        centroCosto: l.centroCosto,
        flujoCaja: l.flujoCaja,
        baseGravable: l.baseGravable,
      });
    }
  }
  return filas.sort(compararPorTipoYNumero);
}

type ItemImprimible =
  | { tipo: 'linea'; fila: FilaLinea }
  | { tipo: 'subtotalDocumento'; debito: number; credito: number };

/** Flattens sorted lines into the exact print sequence — a line, then
 *  (once the next line belongs to a different document) its own subtotal
 *  bar — so pagination can chunk this list directly instead of tracking
 *  "am I at a document boundary" while also tracking "does this row fit on
 *  the current page", the way the pdf-lib original's single imperative
 *  loop did both at once. */
function aItemsImprimibles(filas: FilaLinea[]): ItemImprimible[] {
  const items: ItemImprimible[] = [];
  filas.forEach((f, i) => {
    items.push({ tipo: 'linea', fila: f });
    const siguiente = filas[i + 1];
    const esUltimaDelDocumento =
      !siguiente ||
      siguiente.tipoDocumento !== f.tipoDocumento ||
      siguiente.numeroDocumento !== f.numeroDocumento;
    if (esUltimaDelDocumento) {
      const delDocumento = filas.filter(
        (x) =>
          x.tipoDocumento === f.tipoDocumento &&
          x.numeroDocumento === f.numeroDocumento,
      );
      items.push({
        tipo: 'subtotalDocumento',
        debito: delDocumento.reduce((s, x) => s + (x.debito ?? 0), 0),
        credito: delDocumento.reduce((s, x) => s + (x.credito ?? 0), 0),
      });
    }
  });
  return items;
}

function agruparEnPaginas<T>(items: T[], porPagina: number): T[][] {
  if (items.length === 0) return [[]];
  const paginas: T[][] = [];
  for (let i = 0; i < items.length; i += porPagina) {
    paginas.push(items.slice(i, i + porPagina));
  }
  return paginas;
}

const styles = StyleSheet.create({
  filaEncabezado: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    borderBottomWidth: 0.5,
    borderBottomColor: '#999999',
    paddingVertical: 3,
    marginTop: 6,
    marginBottom: 3,
  },
  fila: {
    flexDirection: 'row',
    paddingVertical: 1.5,
  },
  filaPar: {
    backgroundColor: FONDO_ZEBRA,
  },
  filaSubtotal: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    paddingVertical: 1.5,
  },
  filaFinal: {
    flexDirection: 'row',
    backgroundColor: '#ededed',
    paddingVertical: 3,
    marginTop: 2,
  },
  celdaEncabezado: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
  },
  celda: {
    fontSize: FUENTE_DATOS,
    fontFamily: 'Helvetica',
  },
  celdaFinal: {
    fontSize: FUENTE_DATOS,
    fontFamily: 'Helvetica-Bold',
  },
  sinDatos: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
});

const celdaEstilo = (
  i: number,
  variante: 'encabezado' | 'normal' | 'final',
): Style => ({
  flexGrow: COLUMNAS[i].peso,
  flexBasis: 0,
  textAlign: COLUMNAS[i].numerica ? 'right' : 'left',
  paddingRight: 3,
  ...(variante === 'encabezado'
    ? styles.celdaEncabezado
    : variante === 'final'
      ? styles.celdaFinal
      : styles.celda),
});

const filaSubtotalValores = (debito: number, credito: number): string[] => [
  '',
  '',
  '',
  'Total',
  '',
  '',
  formatoPesoCompacto(debito),
  formatoPesoCompacto(credito),
  '',
  '',
  '',
  '',
];

/**
 * Generates a real PDF for Consulta de Movimiento Contable: the coproperty's
 * full accounting ledger for a date range, flattened to one row per line and
 * closing each document with its own subtotal bar — 12 columns.
 *
 * React-pdf, built directly (no pdf-lib version kept behind a `?version=`
 * toggle). Paginated by hand, same approach as `vencimientos-cartera-pdf.ts`
 * (see that file's `FILAS_POR_PAGINA` docblock for why): line rows and
 * subtotal-bar rows are flattened into one ordered `ItemImprimible[]` first,
 * so chunking into pages doesn't need to track document boundaries and page
 * boundaries at the same time the way the pdf-lib original's single
 * imperative loop did.
 */
export async function generarPdfMovimientoContable(
  reporteCompleto: RespuestaMovimientoContable,
  copropiedad: CopropiedadDocument,
  desde: string,
  hasta: string,
  filtro: FiltroMovimientoContable = {},
): Promise<Buffer> {
  const reporte = filtrarReporte(reporteCompleto, filtro);
  const subtitulo = `${formatoFecha(desde)} al ${formatoFecha(hasta)}`;

  const filas = aFilas(reporte);
  const totalDebitoGeneral = filas.reduce((s, f) => s + (f.debito ?? 0), 0);
  const totalCreditoGeneral = filas.reduce((s, f) => s + (f.credito ?? 0), 0);

  const celda = (
    texto: string,
    i: number,
    variante: 'encabezado' | 'normal' | 'final',
  ) =>
    createElement(
      Text,
      { key: i, style: celdaEstilo(i, variante) },
      variante === 'normal'
        ? truncarTexto(texto, ANCHOS_PT[i], FUENTE_DATOS)
        : texto,
    );

  const masthead = createElement(EncabezadoInforme, {
    copropiedad,
    titulo: 'MOVIMIENTO CONTABLE',
    subtitulo,
  });
  const filaEncabezadoTabla = createElement(
    View,
    { style: styles.filaEncabezado, wrap: false },
    ...COLUMNAS.map((c, i) => celda(c.titulo, i, 'encabezado')),
  );

  if (filas.length === 0) {
    return renderizarPdf(
      reporteDocumentoMultiPagina(
        [
          createElement(
            View,
            null,
            masthead,
            filaEncabezadoTabla,
            createElement(
              Text,
              { style: styles.sinDatos },
              'No hay transacciones contables en el período seleccionado',
            ),
            createElement(CreditoWebsaco),
          ),
        ],
        { orientacion: 'horizontal' },
      ),
    );
  }

  const items = aItemsImprimibles(filas);
  const bloques = agruparEnPaginas(items, FILAS_POR_PAGINA);

  const paginas = bloques.map((bloque, indicePagina) => {
    const esUltima = indicePagina === bloques.length - 1;
    let indiceFilaDato = 0;

    return createElement(
      View,
      null,
      masthead,
      filaEncabezadoTabla,

      ...bloque.map((item, i) => {
        if (item.tipo === 'subtotalDocumento') {
          return createElement(
            View,
            { key: i, style: styles.filaSubtotal, wrap: false },
            ...filaSubtotalValores(item.debito, item.credito).map((v, ci) =>
              celda(v, ci, 'final'),
            ),
          );
        }
        const f = item.fila;
        const valores = [
          f.tipoDocumento,
          f.numeroDocumento,
          f.cuenta,
          f.nombreCuenta,
          f.inmuebleCodigo ?? '—',
          formatoFecha(f.fecha),
          f.debito != null ? formatoPesoCompacto(f.debito) : '',
          f.credito != null ? formatoPesoCompacto(f.credito) : '',
          f.tercero ?? '—',
          f.centroCosto ?? '—',
          f.flujoCaja ?? '—',
          f.baseGravable != null ? formatoPesoCompacto(f.baseGravable) : '—',
        ];
        const esImpar = indiceFilaDato % 2 === 1;
        indiceFilaDato += 1;
        return createElement(
          View,
          {
            key: i,
            style: esImpar ? [styles.fila, styles.filaPar] : styles.fila,
            wrap: false,
          },
          ...valores.map((v, ci) => celda(v, ci, 'normal')),
        );
      }),

      esUltima
        ? createElement(
            View,
            { style: styles.filaFinal, wrap: false },
            ...filaSubtotalValores(totalDebitoGeneral, totalCreditoGeneral).map(
              (v, i) => celda(v, i, 'final'),
            ),
          )
        : null,

      createElement(CreditoWebsaco),
    );
  });

  return renderizarPdf(
    reporteDocumentoMultiPagina(paginas, { orientacion: 'horizontal' }),
  );
}
