// src/modules/actividades/dto/listar-actividades.dto.ts
import { IsIn, IsOptional } from 'class-validator';
import {
  CATEGORIAS_ACTIVIDAD,
  ESTADOS_ACTIVIDAD,
  type CategoriaActividad,
  type EstadoActividad,
} from '../../../database/schemas/administracion/actividad.schema';

export const FILTROS_CATEGORIA_ACTIVIDAD = [
  'todos',
  ...CATEGORIAS_ACTIVIDAD,
] as const;

export const FILTROS_ESTADO_ACTIVIDAD = [
  'todos',
  ...ESTADOS_ACTIVIDAD,
] as const;

/**
 * Query of both activity lists (staff and resident portal). No coproperty
 * parameter: the tenant is always the active one, and the global
 * `forbidNonWhitelisted` pipe rejects a client that still sends it. Unknown
 * values are a 400, not a silently ignored filter.
 */
export class ListarActividadesDto {
  @IsIn(FILTROS_CATEGORIA_ACTIVIDAD)
  @IsOptional()
  categoria?: 'todos' | CategoriaActividad;

  @IsIn(FILTROS_ESTADO_ACTIVIDAD)
  @IsOptional()
  estado?: 'todos' | EstadoActividad;
}
