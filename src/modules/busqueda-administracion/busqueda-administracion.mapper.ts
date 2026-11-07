// src/modules/busqueda-administracion/busqueda-administracion.mapper.ts
import type { Types } from 'mongoose';
import type {
  ResultadoBusquedaAdministracion,
  TipoResultadoBusquedaAdministracion,
} from '../../contracts';

/** Chars of the matching text kept as the hit's second line. */
export const LONGITUD_FRAGMENTO = 120;

/** Trims a long text to a one-line hint; absent text reads as empty. */
export const fragmento = (valor: string | null | undefined): string => {
  if (!valor) return '';
  return valor.length > LONGITUD_FRAGMENTO
    ? `${valor.slice(0, LONGITUD_FRAGMENTO)}...`
    : valor;
};

// Projected shapes: each query selects only what its hit displays.
export interface FilaTareaBusqueda {
  _id: Types.ObjectId;
  titulo: string;
  descripcion?: string;
}
export interface FilaAnuncioBusqueda {
  _id: Types.ObjectId;
  titulo: string;
  contenido?: string;
}
export interface FilaPqrBusqueda {
  _id: Types.ObjectId;
  titulo: string;
  descripcion?: string;
  descripcionCompleta?: string;
}
export interface FilaMantenimientoBusqueda {
  _id: Types.ObjectId;
  titulo: string;
  descripcion?: string;
}
export interface FilaActividadBusqueda {
  _id: Types.ObjectId;
  titulo: string;
  descripcion?: string;
}
export interface FilaDocumentoBusqueda {
  _id: Types.ObjectId;
  nombre: string;
  categoria?: string;
  carpetaId: Types.ObjectId;
}
export interface FilaZonaBusqueda {
  _id: Types.ObjectId;
  nombre: string;
  descripcion?: string;
}
export interface FilaReservaBusqueda {
  _id: Types.ObjectId;
  residente?: string;
  unidad?: string;
  motivo?: string | null;
}
export interface FilaBloqueBusqueda {
  _id: Types.ObjectId;
  nombre: string;
  periodo?: string;
}

const hit = (
  tipo: TipoResultadoBusquedaAdministracion,
  id: Types.ObjectId,
  titulo: string,
  descripcion: string,
  ruta: string,
): ResultadoBusquedaAdministracion => ({
  id: id.toString(),
  tipo,
  titulo,
  descripcion,
  ruta: `${ruta}${ruta.includes('?') ? '&' : '?'}abrir=${id.toString()}`,
});

// The routes are the ones the ported modules' notifications already link to, so
// a search hit and an e-mail button open the same screen.
export const toResultadoTarea = (f: FilaTareaBusqueda) =>
  hit('tarea', f._id, f.titulo, fragmento(f.descripcion), '/tareas');

export const toResultadoAnuncio = (f: FilaAnuncioBusqueda) =>
  hit('anuncio', f._id, f.titulo, fragmento(f.contenido), '/anuncios');

export const toResultadoPqr = (f: FilaPqrBusqueda) =>
  hit(
    'pqr',
    f._id,
    f.titulo,
    fragmento(f.descripcion || f.descripcionCompleta),
    '/pqr',
  );

export const toResultadoMantenimiento = (f: FilaMantenimientoBusqueda) =>
  hit(
    'mantenimiento',
    f._id,
    f.titulo,
    fragmento(f.descripcion),
    '/mantenimientos',
  );

export const toResultadoActividad = (f: FilaActividadBusqueda) =>
  hit('actividad', f._id, f.titulo, fragmento(f.descripcion), '/actividades');

/** `slug` is the folder's, so the screen opens the right folder before the file. */
export const toResultadoDocumento = (f: FilaDocumentoBusqueda, slug: string) =>
  hit(
    'documento',
    f._id,
    f.nombre,
    fragmento(f.categoria),
    `/documentos?carpeta=${encodeURIComponent(slug)}`,
  );

export const toResultadoZona = (f: FilaZonaBusqueda) =>
  hit('zonaComun', f._id, f.nombre, fragmento(f.descripcion), '/zonas-comunes');

export const toResultadoReserva = (f: FilaReservaBusqueda) =>
  hit(
    'reserva',
    f._id,
    f.residente || f.unidad || '',
    fragmento(f.motivo),
    '/reservas',
  );

export const toResultadoBloque = (f: FilaBloqueBusqueda) =>
  hit(
    'facturaBloque',
    f._id,
    f.nombre,
    fragmento(f.periodo),
    '/facturacion-bloque',
  );
