// src/modules/documentos/documentos.mapper.ts
import type {
  AclCarpetaAdministracion,
  ArchivoAdministracion,
  CarpetaAdministracion,
  CarpetaAdministracionPortal,
  PermisosCarpetaAdministracion,
} from '../../contracts';
import type { ArchivoDocumentoDocument } from '../../database/schemas/administracion/documento-archivo.schema';
import type { TipoArchivo } from '../../database/schemas/administracion/documento-archivo.schema';
import type { CarpetaDocumentoDocument } from '../../database/schemas/administracion/documento-carpeta.schema';
import type { EntradaAcl } from './documentos-acceso';

/** Aggregated numbers of one folder (ready files only). */
export interface EstadisticasCarpeta {
  archivos: number;
  tamanoBytes: number;
  actualizado: string;
}

/**
 * The file's `tipo` tag from its MIME type, falling back to the extension for
 * the generic `application/octet-stream` some browsers send. Anything unknown is
 * `otro` (the system this was ported from labelled it `pdf`, which showed the
 * wrong icon).
 */
export const tipoDeArchivo = (mime: string, nombre: string): TipoArchivo => {
  const m = mime.toLowerCase();
  const extension = nombre.toLowerCase().split('.').pop() ?? '';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('wordprocessingml') || m.includes('msword')) return 'docx';
  if (m.includes('spreadsheetml') || m.includes('excel')) return 'xlsx';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m === 'application/octet-stream' || m === '') {
    if (extension === 'pdf') return 'pdf';
    if (extension === 'docx' || extension === 'doc') return 'docx';
    if (extension === 'xlsx' || extension === 'xls') return 'xlsx';
    if (extension === 'png') return 'png';
    if (extension === 'jpg' || extension === 'jpeg') return 'jpg';
  }
  return 'otro';
};

/** A stored rule -> the API union. Role ids leave as strings. */
export const toAcl = (a: EntradaAcl): AclCarpetaAdministracion =>
  a.tipo === 'rol'
    ? {
        tipo: 'rol',
        rolId: String(a.rolId),
        puedeLeer: a.puedeLeer,
        puedeEscribir: a.puedeEscribir,
      }
    : {
        tipo: 'residentes',
        rol: a.rol ?? 'todos',
        puedeLeer: a.puedeLeer,
        // Residents can never write, whatever a legacy row says.
        puedeEscribir: false,
      };

/** File -> contract. `ubicacion` is the folder path text, built by the caller. */
export const toArchivo = (
  doc: ArchivoDocumentoDocument,
  carpetaSlug: string,
  ubicacion: string,
): ArchivoAdministracion => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  nombre: doc.nombre,
  tipo: doc.tipo,
  carpeta: carpetaSlug,
  ubicacion,
  categoria: doc.categoria,
  tamanoBytes: doc.tamanoBytes,
  modificado: (
    (doc as unknown as { updatedAt?: Date }).updatedAt ?? new Date()
  ).toISOString(),
  autor: doc.autorNombre,
  destacado: doc.destacado,
  etiquetas: doc.etiquetas,
  tieneArchivo: doc.rutaAlmacenamiento != null && doc.estado === 'listo',
});

/** Folder -> staff contract, with its own rules, the inherited ones and the caller's access. */
export const toCarpeta = (
  doc: CarpetaDocumentoDocument,
  estadisticas: EstadisticasCarpeta,
  permisos: PermisosCarpetaAdministracion,
  herencia: {
    heredaDe: string | null;
    permisosHeredados: AclCarpetaAdministracion[];
  } = { heredaDe: null, permisosHeredados: [] },
): CarpetaAdministracion => ({
  id: doc._id.toString(),
  slug: doc.slug,
  nombre: doc.nombre,
  descripcion: doc.descripcion,
  icono: doc.icono,
  color: doc.color,
  parentId: doc.carpetaPadreId ? doc.carpetaPadreId.toString() : null,
  acls: (doc.acls ?? []).map(toAcl),
  archivos: estadisticas.archivos,
  actualizado: estadisticas.actualizado,
  tamanoBytes: estadisticas.tamanoBytes,
  permisos,
  heredaDe: herencia.heredaDe,
  permisosHeredados: herencia.permisosHeredados,
});

/**
 * Folder -> resident contract. A SECURITY boundary: rules, role ids and
 * permissions are left out on purpose, so a resident cannot learn which staff
 * roles exist or who else can see a folder.
 */
export const toCarpetaPortal = (
  doc: CarpetaDocumentoDocument,
  estadisticas: EstadisticasCarpeta,
): CarpetaAdministracionPortal => ({
  id: doc._id.toString(),
  slug: doc.slug,
  nombre: doc.nombre,
  descripcion: doc.descripcion,
  icono: doc.icono,
  color: doc.color,
  parentId: doc.carpetaPadreId ? doc.carpetaPadreId.toString() : null,
  archivos: estadisticas.archivos,
  actualizado: estadisticas.actualizado,
  tamanoBytes: estadisticas.tamanoBytes,
});
