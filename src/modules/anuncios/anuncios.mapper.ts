// src/modules/anuncios/anuncios.mapper.ts
import { Types } from 'mongoose';
import type { Anuncio } from '../../contracts';
import type { AnuncioDocument } from '../../database/schemas/administracion/anuncio.schema';
import { toIso } from '../../common/utils/mapper.utils';
import type { ActualizarAnuncioDto } from './dto/actualizar-anuncio.dto';
import type { CrearAnuncioDto } from './dto/guardar-anuncio.dto';

/** What the caller is allowed to see on top of the public shape. */
export interface OpcionesAnuncio {
  /** The resident portal passes its account id so `likedByMe` is set. */
  cuentaId?: string;
  /** Staff only: the delivery progress. Residents never see who was notified. */
  incluirEntrega?: boolean;
}

/**
 * Maps an Anuncio document to the API contract. Persisted values already ARE the
 * contract values. `likes` is derived from the array, so it cannot disagree with
 * who liked; the id arrays themselves (likes, delivery progress) are never
 * exposed, only counts, and the lease token never leaves the server.
 */
export const toAnuncio = (
  doc: AnuncioDocument,
  opciones: OpcionesAnuncio = {},
): Anuncio => ({
  id: doc._id.toString(),
  titulo: doc.titulo,
  contenido: doc.contenido,
  categoria: doc.categoria,
  autor: doc.autor,
  fecha:
    toIso(doc.publicadoEn) ??
    toIso((doc as unknown as { createdAt?: Date }).createdAt) ??
    '',
  imagen: doc.imagenUrl,
  destacado: doc.destacado,
  vistas: doc.vistas,
  likes: doc.meGustaIds.length,
  estado: doc.estado,
  ...(opciones.cuentaId !== undefined && {
    likedByMe: doc.meGustaIds.some((id) => id.toString() === opciones.cuentaId),
  }),
  ...(opciones.incluirEntrega && {
    entrega: {
      destinatarios: doc.destinatariosTotal,
      notificados: doc.notificadosIds.length,
      correosEnviados: doc.correosEnviadosIds.length,
      correoConfigurado: doc.correoConfigurado,
    },
  }),
});

/**
 * Builds the document fields for a new announcement: always a draft, with no
 * likes, views or delivery progress. `copropiedadId` comes from the request
 * context and `autor` from the caller's account, never from the payload.
 */
export const desdeCrearDto = (
  dto: CrearAnuncioDto,
  copropiedadId: Types.ObjectId,
  autor: string,
) => ({
  copropiedadId,
  titulo: dto.titulo,
  contenido: dto.contenido,
  categoria: dto.categoria,
  autor,
  imagenUrl: dto.imagen ?? null,
  destacado: dto.destacado ?? false,
  estado: 'borrador' as const,
});

/** Builds a partial `$set` from an update payload: only the fields the client sent. */
export const desdeActualizarDto = (
  dto: ActualizarAnuncioDto,
): Record<string, unknown> => {
  const cambios: Record<string, unknown> = {};
  if (dto.titulo !== undefined) cambios.titulo = dto.titulo;
  if (dto.contenido !== undefined) cambios.contenido = dto.contenido;
  if (dto.categoria !== undefined) cambios.categoria = dto.categoria;
  if (dto.imagen !== undefined) cambios.imagenUrl = dto.imagen;
  if (dto.destacado !== undefined) cambios.destacado = dto.destacado;
  return cambios;
};
