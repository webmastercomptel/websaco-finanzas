import { createElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
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
import type { RespuestaConsecutivos } from '../../contracts';

/** Up to 11 concepts get their own column; anything beyond that is summed
 *  into one final "Otros Cargos" column — same cap every other dynamic-
 *  concept report in this module uses (`consulta-facturacion-pdf.ts`,
 *  `cartera-por-inmueble-pdf.ts`). */
const MAX_CARGOS_INDIVIDUALES = 11;

/** Same reasoning as `vencimientos-cartera-pdf.ts`'s own constant — manual
 *  per-page pagination instead of react-pdf's automatic `wrap`. */
const FILAS_POR_PAGINA = 38;

interface ColumnaTabla {
  titulo: string;
  peso: number;
  numerica: boolean;
}

function formatoPesoCompacto(valor: number): string {
  return valor.toLocaleString('es-CO', { maximumFractionDigits: 0 });
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
 * Generates a real PDF for Consecutivos: every document of one type ("código"
 * from the Tabla de Documentos) issued within a period, broken down by
 * charge concept — dynamic concept columns like Consulta de Facturación.
 *
 * React-pdf, built directly (no pdf-lib version kept behind a `?version=`
 * toggle). Paginated by hand, same approach as `vencimientos-cartera-pdf.ts`
 * (see that file's `FILAS_POR_PAGINA` docblock for why).
 */
export async function generarPdfConsecutivos(
  reporte: RespuestaConsecutivos,
  copropiedad: CopropiedadDocument,
  codigo: string,
  desde: string,
  hasta: string,
): Promise<Buffer> {
  const conceptosIndividuales = reporte.conceptos.slice(
    0,
    MAX_CARGOS_INDIVIDUALES,
  );
  const conceptosAgrupados = reporte.conceptos.slice(MAX_CARGOS_INDIVIDUALES);
  const hayOtros = conceptosAgrupados.length > 0;

  const COLUMNAS: ColumnaTabla[] = [
    { titulo: 'Tipo Doc.', peso: 0.7, numerica: false },
    { titulo: 'Número', peso: 1.3, numerica: false },
    { titulo: 'Inmueble', peso: 0.9, numerica: false },
    { titulo: 'Fecha', peso: 0.9, numerica: false },
    { titulo: 'Valor Total', peso: 1.2, numerica: true },
    ...conceptosIndividuales.map((c) => ({
      titulo: c.nombre,
      peso: 1.1,
      numerica: true,
    })),
    ...(hayOtros
      ? [{ titulo: 'Otros Cargos', peso: 1.1, numerica: true }]
      : []),
  ];
  const pesoTotal = COLUMNAS.reduce((acc, c) => acc + c.peso, 0);
  const anchosPt = COLUMNAS.map(
    (c) => (c.peso / pesoTotal) * CONTENT_WIDTH_PT_HORIZONTAL,
  );
  const fuenteDatos = Math.max(
    5.5,
    7 - Math.max(0, COLUMNAS.length - 10) * 0.3,
  );
  const fuenteTitulo = Math.max(6, 8 - Math.max(0, COLUMNAS.length - 10) * 0.2);

  const subtitulo = `${codigo} — ${formatoFecha(desde)} al ${formatoFecha(hasta)}`;

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
    fila: { flexDirection: 'row', paddingVertical: 1.5 },
    filaPar: { backgroundColor: FONDO_ZEBRA },
    filaFinal: {
      flexDirection: 'row',
      backgroundColor: '#ededed',
      paddingVertical: 3,
      marginTop: 2,
    },
    celdaEncabezado: { fontSize: fuenteTitulo, fontFamily: 'Helvetica-Bold' },
    celda: { fontSize: fuenteDatos, fontFamily: 'Helvetica' },
    celdaFinal: { fontSize: fuenteDatos, fontFamily: 'Helvetica-Bold' },
    sinDatos: { fontSize: fuenteDatos + 2, fontFamily: 'Helvetica' },
  });

  const celdaEstilo = (
    i: number,
    variante: 'encabezado' | 'normal' | 'final',
  ) => ({
    flexGrow: COLUMNAS[i].peso,
    flexBasis: 0,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- widened to `string` without it; only flagged as unnecessary because the rule ignores the downstream react-pdf Style prop context.
    textAlign: (COLUMNAS[i].numerica ? 'right' : 'left') as 'right' | 'left',
    paddingRight: 3,
    ...(variante === 'encabezado'
      ? styles.celdaEncabezado
      : variante === 'final'
        ? styles.celdaFinal
        : styles.celda),
  });

  const celda = (
    texto: string,
    i: number,
    variante: 'encabezado' | 'normal' | 'final',
  ) =>
    createElement(
      Text,
      { key: i, style: celdaEstilo(i, variante) },
      variante === 'normal'
        ? truncarTexto(texto, anchosPt[i], fuenteDatos)
        : texto,
    );

  const masthead = createElement(EncabezadoInforme, {
    copropiedad,
    titulo: 'CONSECUTIVOS',
    subtitulo,
    fechaGeneracion: new Date(),
  });
  const filaEncabezadoTabla = createElement(
    View,
    { style: styles.filaEncabezado, wrap: false },
    ...COLUMNAS.map((c, i) => celda(c.titulo, i, 'encabezado')),
  );

  if (reporte.filas.length === 0) {
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
              'No hay documentos de este tipo en el período seleccionado',
            ),
            createElement(CreditoWebsaco),
          ),
        ],
        { orientacion: 'horizontal' },
      ),
    );
  }

  const totalesPorConcepto = new Map<string, number>();
  let totalGeneral = 0;
  for (const f of reporte.filas) {
    for (const c of reporte.conceptos) {
      const monto = f.cargosPorConcepto[c.conceptoId] ?? 0;
      totalesPorConcepto.set(
        c.conceptoId,
        (totalesPorConcepto.get(c.conceptoId) ?? 0) + monto,
      );
    }
    totalGeneral += f.valorTotal;
  }
  const totalOtros = conceptosAgrupados.reduce(
    (acc, c) => acc + (totalesPorConcepto.get(c.conceptoId) ?? 0),
    0,
  );

  const bloques = agruparEnPaginas(reporte.filas, FILAS_POR_PAGINA);

  const paginas = bloques.map((bloque, indicePagina) => {
    const esUltima = indicePagina === bloques.length - 1;

    return createElement(
      View,
      null,
      masthead,
      filaEncabezadoTabla,

      ...bloque.map((f, i) => {
        const otros = conceptosAgrupados.reduce(
          (acc, c) => acc + (f.cargosPorConcepto[c.conceptoId] ?? 0),
          0,
        );
        const valores = [
          f.tipoDocumento,
          f.numeroCompleto,
          f.inmuebleCodigo,
          formatoFecha(f.fecha),
          formatoPesoCompacto(f.valorTotal),
          ...conceptosIndividuales.map((c) =>
            formatoPesoCompacto(f.cargosPorConcepto[c.conceptoId] ?? 0),
          ),
          ...(hayOtros ? [formatoPesoCompacto(otros)] : []),
        ];
        return createElement(
          View,
          {
            key: i,
            style: i % 2 === 1 ? [styles.fila, styles.filaPar] : styles.fila,
            wrap: false,
          },
          ...valores.map((v, ci) => celda(v, ci, 'normal')),
        );
      }),

      esUltima
        ? createElement(
            View,
            { style: styles.filaFinal, wrap: false },
            ...[
              'TOTAL',
              '',
              '',
              '',
              formatoPesoCompacto(totalGeneral),
              ...conceptosIndividuales.map((c) =>
                formatoPesoCompacto(totalesPorConcepto.get(c.conceptoId) ?? 0),
              ),
              ...(hayOtros ? [formatoPesoCompacto(totalOtros)] : []),
            ].map((v, i) => celda(v, i, 'final')),
          )
        : null,

      createElement(CreditoWebsaco),
    );
  });

  return renderizarPdf(
    reporteDocumentoMultiPagina(paginas, { orientacion: 'horizontal' }),
  );
}
