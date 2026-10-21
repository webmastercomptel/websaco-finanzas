// src/modules/inmuebles/inmuebles.mapper.ts
import { Types } from 'mongoose';
import { formatEmails } from '../../common/utils/email.utils';
import type {
  AdvertenciaVistaPreviaImportacion,
  ErrorImportacionInmueble,
  FilaExportacionInmueble,
  Inmueble as InmuebleContract,
  TitularResumen,
  VistaPreviaImportacionInmuebles,
} from '../../contracts';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';

/** The shape `titularId` arrives in when the query populated it. */
type TitularPoblado = Pick<
  TerceroDocument,
  'nombre' | 'numeroIdentificacion'
> & {
  _id: Types.ObjectId;
};

/**
 * Reads the holder off a `titularId` that may or may not have been populated.
 *
 * Returns null rather than a half-filled object when it was not: a listing that
 * quietly shows every unit as unowned because somebody forgot `.populate()` is
 * worse than one that shows nothing, because it looks plausible.
 */
const titularDe = (titularId: unknown): TitularResumen | null => {
  if (!titularId || titularId instanceof Types.ObjectId) return null;
  if (typeof titularId !== 'object' || !('nombre' in titularId)) return null;

  const tercero = titularId as TitularPoblado;
  return {
    id: tercero._id.toString(),
    nombre: tercero.nombre,
    identificacion: tercero.numeroIdentificacion ?? null,
  };
};

/**
 * Maps a unit document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md.
 */
export const toInmueble = (doc: InmuebleDocument): InmuebleContract => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  referencia: doc.referencia,
  bloque: doc.bloque,
  zona: doc.zona,
  uso: doc.uso,
  area: doc.area,
  coeficiente: doc.coeficiente,
  titular: titularDe(doc.titularId),
  tipoTitular: doc.tipoTitular,
  resideEnElInmueble: doc.resideEnElInmueble,
  estadoCartera: doc.estadoCartera,
  estado: doc.estado === 'active' ? 'activo' : 'inactivo',
  observaciones: doc.observaciones,
  fechaActualizacion: doc.updatedAt.toISOString(),
});

/** The unit columns the export reads — a lean document, so any of them may be
 *  absent on legacy rows. */
export type UnidadParaExportar = Partial<
  Pick<
    InmuebleDocument,
    | 'referencia'
    | 'bloque'
    | 'zona'
    | 'uso'
    | 'area'
    | 'coeficiente'
    | 'tipoTitular'
    | 'resideEnElInmueble'
    | 'estadoCartera'
    | 'contacto'
    | 'observaciones'
  >
> &
  Pick<InmuebleDocument, 'codigo'>;

/** The Tercero columns the export reads, same leniency as above. */
export type TerceroParaExportar = Partial<
  Pick<
    TerceroDocument,
    | 'primerNombre'
    | 'segundoNombre'
    | 'primerApellido'
    | 'segundoApellido'
    | 'razonSocial'
    | 'tipoIdentificacion'
    | 'numeroIdentificacion'
    | 'digitoVerificacion'
    | 'emails'
    | 'telefono'
    | 'direccion'
    | 'ciudadCodigo'
  >
>;

/**
 * Maps a unit (and its joined titular) to one row of the import-shaped
 * export. The key order here IS the column order of the import template, so
 * an object spread or a reordering would silently shuffle the file's columns:
 * keep the literal as is.
 *
 * Absent values become `""` (never null) because a spreadsheet cell has no
 * null, and `area`/`coeficiente` keep their number so the sheet stays
 * numeric. `ciudadTitular` carries the DANE CODE and `tipoIdentificacionTitular`
 * the DIAN code — what the import validates against — not the display names.
 * Emails go through `formatEmails`, the inverse of the import's parser.
 *
 * Pure on purpose: the service owns the queries and the tenant scoping, this
 * only reshapes what it was handed.
 */
export const toFilaExportacion = (
  copropiedadCodigo: string,
  unidad: UnidadParaExportar,
  titular?: TerceroParaExportar | null,
): FilaExportacionInmueble => ({
  codigoCopropiedad: copropiedadCodigo,
  codigo: unidad.codigo,
  referencia: unidad.referencia ?? '',
  bloque: unidad.bloque ?? '',
  zona: unidad.zona ?? '',
  uso: unidad.uso ?? '',
  area: unidad.area ?? '',
  coeficiente: unidad.coeficiente ?? '',
  tipoTitular: unidad.tipoTitular ?? '',
  resideEnElInmueble: unidad.resideEnElInmueble ?? false,
  estadoCartera: unidad.estadoCartera ?? '',
  contacto: unidad.contacto ?? '',
  observaciones: unidad.observaciones ?? '',
  nom1Titular: titular?.primerNombre ?? '',
  nom2Titular: titular?.segundoNombre ?? '',
  ape1Titular: titular?.primerApellido ?? '',
  ape2Titular: titular?.segundoApellido ?? '',
  razonSocialTitular: titular?.razonSocial ?? '',
  tipoIdentificacionTitular: titular?.tipoIdentificacion ?? '',
  numeroIdentificacionTitular: titular?.numeroIdentificacion ?? '',
  digitoVerificacionTitular: titular?.digitoVerificacion ?? '',
  emailTitular: formatEmails(titular?.emails),
  telefonoTitular: titular?.telefono ?? '',
  direccionTitular: titular?.direccion ?? '',
  ciudadTitular: titular?.ciudadCodigo ?? '',
});

/** Caps on the lists of the import preview: it answers in one JSON body, and
 *  a 3000-row file must not echo thousands of codes back. The COUNTS are never
 *  capped, only the lists, with a `truncado` flag beside each. */
export const MAX_CODIGOS_A_CREAR_VISTA_PREVIA = 200;
export const MAX_AUSENTES_VISTA_PREVIA = 500;

/** What the service worked out about a file, before shaping the response. */
export interface ClasificacionVistaPrevia {
  total: number;
  /** Codes of the rows that would create a unit, in file order. */
  codigosACrear: string[];
  aActualizar: number;
  repetidasEnArchivo: number;
  titularesNuevos: number;
  errores: ErrorImportacionInmueble[];
  advertencias: AdvertenciaVistaPreviaImportacion[];
  /** Stored codes of the active units missing from the file. */
  ausentes: string[];
}

/**
 * Shapes a classification into the preview contract, applying the list caps.
 * Pure: the service owns the queries and the classification.
 */
export const toVistaPreviaImportacion = (
  c: ClasificacionVistaPrevia,
): VistaPreviaImportacionInmuebles => ({
  total: c.total,
  aCrear: c.codigosACrear.length,
  aActualizar: c.aActualizar,
  repetidasEnArchivo: c.repetidasEnArchivo,
  titularesNuevos: c.titularesNuevos,
  errores: c.errores,
  codigosACrear: c.codigosACrear.slice(0, MAX_CODIGOS_A_CREAR_VISTA_PREVIA),
  codigosACrearTruncado:
    c.codigosACrear.length > MAX_CODIGOS_A_CREAR_VISTA_PREVIA,
  advertencias: c.advertencias,
  ausentes: {
    total: c.ausentes.length,
    codigos: c.ausentes.slice(0, MAX_AUSENTES_VISTA_PREVIA),
    truncado: c.ausentes.length > MAX_AUSENTES_VISTA_PREVIA,
  },
  abortaImport: false,
});

/**
 * The preview of a file `importar` would reject whole (a row carries another
 * coproperty's code): only the offending rows are listed and every count is
 * zero, because the import would write nothing at all.
 */
export const toVistaPreviaAbortada = (
  total: number,
  errores: ErrorImportacionInmueble[],
): VistaPreviaImportacionInmuebles => ({
  total,
  aCrear: 0,
  aActualizar: 0,
  repetidasEnArchivo: 0,
  titularesNuevos: 0,
  errores,
  codigosACrear: [],
  codigosACrearTruncado: false,
  advertencias: [],
  ausentes: { total: 0, codigos: [], truncado: false },
  abortaImport: true,
});
