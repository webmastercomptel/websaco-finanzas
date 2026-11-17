import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  reporteDocumentoMultiPagina,
  renderizarPdf,
  CONTENT_WIDTH_PT,
} from './react/document';
import { CreditoWebsaco } from './react/credito-websaco';
import { EncabezadoInforme } from './react/encabezado-informe';
import { FONDO_ZEBRA } from './react/paleta';
import { TablaResumen, type FilaResumen } from './react/tabla-resumen';
import { truncarTexto } from './react/text-measure';
import { TituloSeccion } from './react/titulo-seccion';
import { formatoPeso } from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  resumirActividades,
  resumirMantenimientos,
  resumirPqr,
  type FilaActividad,
  type FilaMantenimiento,
  type FilaPqr,
} from '../../modules/informe-gestion/informe-gestion.resumen';

/** Sections the caller may read; an absent key is never drawn (no title, no counts). */
export interface SeccionesInformeGestion {
  actividades?: FilaActividad[];
  mantenimientos?: FilaMantenimiento[];
  pqr?: FilaPqr[];
}

const ETIQUETAS_ACTIVIDAD_ESTADO: Record<string, string> = {
  proximo: 'Próximo',
  en_curso: 'En curso',
  finalizado: 'Finalizado',
  cancelado: 'Cancelado',
};
const ETIQUETAS_ACTIVIDAD_CATEGORIA: Record<string, string> = {
  integracion: 'Integración',
  salud: 'Salud',
  asamblea: 'Asamblea',
  cultural: 'Cultural',
  deportivo: 'Deportivo',
  operativo: 'Operativo',
};
const ETIQUETAS_MANT_TIPO: Record<string, string> = {
  preventivo: 'Preventivo',
  correctivo: 'Correctivo',
};
const ETIQUETAS_MANT_ESTADO: Record<string, string> = {
  programado: 'Programado',
  en_progreso: 'En progreso',
  completado: 'Completado',
  cancelado: 'Cancelado',
};
const ETIQUETAS_PQR_TIPO: Record<string, string> = {
  peticiones: 'Petición',
  quejas: 'Queja',
  reclamos: 'Reclamo',
  sugerencias: 'Sugerencia',
  felicitaciones: 'Felicitación',
  denuncias: 'Denuncia',
};
const ETIQUETAS_PQR_ESTADO: Record<string, string> = {
  urgente: 'Urgente',
  en_revision: 'En revisión',
  pendiente: 'Pendiente',
  resuelto: 'Resuelto',
  cerrado: 'Cerrado',
};
const ETIQUETAS_PQR_PRIORIDAD: Record<string, string> = {
  alta: 'Alta',
  media: 'Media',
  normal: 'Normal',
  baja: 'Baja',
};

/** An unknown key prints itself — a new enum value must never crash a report. */
const etiqueta = (mapa: Record<string, string>, clave: string): string =>
  mapa[clave] ?? clave;

const SIN_REGISTROS = 'Sin registros en el período.';
const VACIO = '—';
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

/** d/M/yyyy without zero padding, from a UTC calendar date. */
function dmaUtc(fecha: Date): string {
  return `${fecha.getUTCDate()}/${fecha.getUTCMonth() + 1}/${fecha.getUTCFullYear()}`;
}

/** Activity/maintenance dates are business dates stored at UTC midnight. */
const fechaNegocio = (fecha: Date): string => dmaUtc(fecha);

/** PQR `createdAt` is a real instant: print its Bogotá day (UTC-5, no DST). */
const fechaBogota = (fecha: Date): string =>
  dmaUtc(new Date(fecha.getTime() - BOGOTA_OFFSET_MS));

/** `YYYY-MM-DD` (already validated by the caller) to d/M/yyyy. */
function dmaIso(iso: string): string {
  const [a, m, d] = iso.split('-').map(Number);
  return `${d}/${m}/${a}`;
}

/** Counts for every known key (zeros included) followed by any unknown key present. */
function filasConteo(
  conteo: Record<string, number>,
  mapa: Record<string, string>,
): FilaResumen[] {
  const claves = [
    ...Object.keys(mapa),
    ...Object.keys(conteo).filter((k) => !(k in mapa)),
  ];
  return claves.map((k) => ({
    label: etiqueta(mapa, k),
    valor: String(conteo[k] ?? 0),
  }));
}

/**
 * Rows per page, set by hand (see `inmuebles-listado-pdf.ts`): react-pdf must
 * never overflow a page, or it adds a blank continuation page with no header.
 * Portrait Letter holds more than this; the value leaves headroom for the
 * masthead, section title and column bar.
 */
const FILAS_POR_PAGINA = 34;

const FONT_SIZE = 8;

const styles = StyleSheet.create({
  filaEncabezado: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#000000',
    paddingVertical: 3,
    marginTop: 6,
  },
  fila: { flexDirection: 'row', paddingVertical: 2 },
  filaPar: { backgroundColor: FONDO_ZEBRA },
  celdaEncabezado: { fontSize: FONT_SIZE, fontFamily: 'Helvetica-Bold' },
  celda: { fontSize: FONT_SIZE, fontFamily: 'Helvetica' },
  vacio: { fontSize: 9, fontFamily: 'Helvetica', marginTop: 6 },
});

interface ColumnaTabla {
  titulo: string;
  /** Relative width weight. */
  peso: number;
  derecha?: boolean;
}

interface TablaDetalle {
  titulo: string;
  columnas: ColumnaTabla[];
  filas: string[][];
}

function agruparEnPaginas<T>(items: T[], porPagina: number): T[][] {
  if (items.length === 0) return [[]];
  const paginas: T[][] = [];
  for (let i = 0; i < items.length; i += porPagina) {
    paginas.push(items.slice(i, i + porPagina));
  }
  return paginas;
}

function celdaTabla(
  texto: string,
  col: ColumnaTabla,
  ancho: number,
  encabezado: boolean,
  i: number,
): ReactElement {
  return createElement(
    Text,
    {
      key: i,
      style: [
        encabezado ? styles.celdaEncabezado : styles.celda,
        {
          flexGrow: col.peso,
          flexBasis: 0,
          textAlign: col.derecha ? 'right' : 'left',
        },
      ],
    },
    truncarTexto(texto, ancho - 6, FONT_SIZE),
  );
}

/** One page per block of rows, each repeating masthead, title and column bar. */
function paginasDeTabla(
  tabla: TablaDetalle,
  encabezado: () => ReactElement,
  credito: () => ReactElement,
): ReactElement[] {
  const pesoTotal = tabla.columnas.reduce((s, c) => s + c.peso, 0);
  const anchos = tabla.columnas.map(
    (c) => (CONTENT_WIDTH_PT * c.peso) / pesoTotal,
  );
  return agruparEnPaginas(tabla.filas, FILAS_POR_PAGINA).map((bloque, p) =>
    createElement(
      View,
      {
        key: `${tabla.titulo}-${p}`,
        style: { flexDirection: 'column', flexGrow: 1 },
      },
      encabezado(),
      createElement(TituloSeccion, { texto: tabla.titulo }),
      tabla.filas.length === 0
        ? createElement(Text, { style: styles.vacio }, SIN_REGISTROS)
        : createElement(
            View,
            { style: styles.filaEncabezado, wrap: false },
            ...tabla.columnas.map((c, i) =>
              celdaTabla(c.titulo, c, anchos[i], true, i),
            ),
          ),
      ...bloque.map((fila, idx) =>
        createElement(
          View,
          {
            key: idx,
            style: idx % 2 === 1 ? [styles.fila, styles.filaPar] : styles.fila,
            wrap: false,
          },
          ...fila.map((v, i) =>
            celdaTabla(v, tabla.columnas[i], anchos[i], false, i),
          ),
        ),
      ),
      credito(),
    ),
  );
}

const porFecha = <T extends { fecha: Date }>(filas: T[]): T[] =>
  [...filas].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

/**
 * Printable «Soporte a infogestión»: a summary page with figures, then one
 * detail table per section the caller may read. The summary is computed here
 * with the shared `resumir*` functions so it can never disagree with the
 * screen. An ABSENT section key means the caller lacks that permission: it is
 * not drawn at all — not its title, not its counts.
 */
export async function generarPdfInformeGestion(
  copropiedad: CopropiedadDocument,
  periodo: { desde: string; hasta: string },
  secciones: SeccionesInformeGestion,
): Promise<Buffer> {
  const fechaGeneracion = new Date();
  const encabezado = () =>
    createElement(EncabezadoInforme, {
      copropiedad,
      titulo: 'Soporte a infogestión',
      subtitulo: `Período: ${dmaIso(periodo.desde)} – ${dmaIso(periodo.hasta)}`,
    });
  const credito = () => createElement(CreditoWebsaco, { fechaGeneracion });

  const bloquesResumen: ReactElement[] = [];
  const tablas: TablaDetalle[] = [];

  if (secciones.actividades) {
    const filas = porFecha(secciones.actividades);
    const r = resumirActividades(filas);
    bloquesResumen.push(
      createElement(TituloSeccion, { key: 'ra', texto: 'Actividades' }),
      createElement(TablaResumen, {
        key: 'ta',
        filas: [
          { label: 'Total de actividades', valor: String(r.total) },
          ...filasConteo(r.porEstado, ETIQUETAS_ACTIVIDAD_ESTADO),
          { label: 'Inscritos', valor: String(r.inscritos) },
        ],
      }),
    );
    tablas.push({
      titulo: 'Actividades',
      columnas: [
        { titulo: 'Fecha', peso: 1 },
        { titulo: 'Título', peso: 3 },
        { titulo: 'Categoría', peso: 1.4 },
        { titulo: 'Estado', peso: 1.2 },
        { titulo: 'Inscritos', peso: 1, derecha: true },
      ],
      filas: filas.map((f) => [
        fechaNegocio(f.fecha),
        f.titulo,
        etiqueta(ETIQUETAS_ACTIVIDAD_CATEGORIA, f.categoria),
        etiqueta(ETIQUETAS_ACTIVIDAD_ESTADO, f.estado),
        String(f.inscritos),
      ]),
    });
  }

  if (secciones.mantenimientos) {
    const filas = porFecha(secciones.mantenimientos);
    const r = resumirMantenimientos(filas);
    bloquesResumen.push(
      createElement(TituloSeccion, { key: 'rm', texto: 'Mantenimientos' }),
      createElement(TablaResumen, {
        key: 'tm',
        filas: [
          { label: 'Total de mantenimientos', valor: String(r.total) },
          ...filasConteo(r.porTipo, ETIQUETAS_MANT_TIPO),
          ...filasConteo(r.porEstado, ETIQUETAS_MANT_ESTADO),
          {
            label: 'Costo estimado total',
            valor: formatoPeso(r.costoEstimadoTotal),
          },
          { label: 'Equipos atendidos', valor: String(r.equiposAtendidos) },
        ],
      }),
    );
    tablas.push({
      titulo: 'Mantenimientos',
      columnas: [
        { titulo: 'Fecha', peso: 1 },
        { titulo: 'Título', peso: 2.6 },
        { titulo: 'Tipo', peso: 1.1 },
        { titulo: 'Equipo', peso: 1.8 },
        { titulo: 'Responsable', peso: 1.8 },
        { titulo: 'Estado', peso: 1.2 },
        { titulo: 'Costo estimado', peso: 1.5, derecha: true },
      ],
      filas: filas.map((f) => [
        fechaNegocio(f.fecha),
        f.titulo,
        etiqueta(ETIQUETAS_MANT_TIPO, f.tipo),
        f.equipo || VACIO,
        f.responsable || VACIO,
        etiqueta(ETIQUETAS_MANT_ESTADO, f.estado),
        f.costoEstimado !== null && Number.isFinite(f.costoEstimado)
          ? formatoPeso(f.costoEstimado)
          : VACIO,
      ]),
    });
  }

  if (secciones.pqr) {
    const filas = porFecha(secciones.pqr);
    const r = resumirPqr(filas);
    bloquesResumen.push(
      createElement(TituloSeccion, { key: 'rp', texto: 'PQR' }),
      createElement(TablaResumen, {
        key: 'tp',
        filas: [
          { label: 'Total de PQR', valor: String(r.total) },
          ...filasConteo(r.porTipo, ETIQUETAS_PQR_TIPO),
          ...filasConteo(r.porEstado, ETIQUETAS_PQR_ESTADO),
          { label: 'PQR abiertas', valor: String(r.abiertas) },
        ],
      }),
    );
    tablas.push({
      titulo: 'PQR',
      columnas: [
        { titulo: 'Fecha', peso: 1 },
        { titulo: 'Código', peso: 1.2 },
        { titulo: 'Unidad', peso: 1.4 },
        { titulo: 'Tipo', peso: 1.3 },
        { titulo: 'Prioridad', peso: 1.1 },
        { titulo: 'Estado', peso: 1.3 },
      ],
      filas: filas.map((f) => [
        fechaBogota(f.fecha),
        f.codigo,
        f.unidad,
        etiqueta(ETIQUETAS_PQR_TIPO, f.tipo),
        etiqueta(ETIQUETAS_PQR_PRIORIDAD, f.prioridad),
        etiqueta(ETIQUETAS_PQR_ESTADO, f.estado),
      ]),
    });
  }

  const paginas: ReactElement[] = [
    createElement(
      View,
      { key: 'resumen', style: { flexDirection: 'column', flexGrow: 1 } },
      encabezado(),
      createElement(TituloSeccion, { texto: 'Resumen' }),
      ...bloquesResumen,
      credito(),
    ),
    ...tablas.flatMap((t) => paginasDeTabla(t, encabezado, credito)),
  ];

  return renderizarPdf(reporteDocumentoMultiPagina(paginas));
}
