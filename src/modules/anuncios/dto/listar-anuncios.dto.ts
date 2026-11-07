// src/modules/anuncios/dto/listar-anuncios.dto.ts
import { IsIn, IsOptional } from 'class-validator';
import {
  CATEGORIAS_ANUNCIO,
  ESTADOS_ANUNCIO,
  type CategoriaAnuncio,
  type EstadoAnuncio,
} from '../../../database/schemas/administracion/anuncio.schema';

export const FILTROS_CATEGORIA_ANUNCIO = [
  'todos',
  ...CATEGORIAS_ANUNCIO,
] as const;

export const FILTROS_ESTADO_ANUNCIO = ['todos', ...ESTADOS_ANUNCIO] as const;

/**
 * Query of the resident announcement list. No coproperty parameter: the tenant
 * is always the active one, and the global `forbidNonWhitelisted` pipe rejects a
 * client that still sends it. There is no `estado` filter on purpose: a
 * resident never chooses what is published. Unknown values are a 400.
 */
export class ListarAnunciosPortalDto {
  @IsIn(FILTROS_CATEGORIA_ANUNCIO)
  @IsOptional()
  categoria?: 'todos' | CategoriaAnuncio;
}

/** Query of the staff announcement list: the resident filters plus the lifecycle state. */
export class ListarAnunciosDto extends ListarAnunciosPortalDto {
  @IsIn(FILTROS_ESTADO_ANUNCIO)
  @IsOptional()
  estado?: 'todos' | EstadoAnuncio;
}
