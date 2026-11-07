// src/modules/zonas/dto/listar-zonas.dto.ts
import { IsIn, IsOptional } from 'class-validator';
import {
  ESTADOS_ZONA,
  TIPOS_ZONA,
  type EstadoZona,
  type TipoZona,
} from '../../../database/schemas/administracion/zona.schema';

export const FILTROS_TIPO_ZONA = ['todos', ...TIPOS_ZONA] as const;
export const FILTROS_ESTADO_ZONA = ['todos', ...ESTADOS_ZONA] as const;

/**
 * Query of `GET /zonas-comunes`. No coproperty parameter: the tenant is always
 * the active one, and the global `forbidNonWhitelisted` pipe rejects a client
 * that still sends `coPropertyId`. Unknown values are a 400, not a silently
 * ignored filter (the system this replaces ignored them).
 */
export class ListarZonasDto {
  @IsIn(FILTROS_TIPO_ZONA)
  @IsOptional()
  tipo?: 'todos' | TipoZona;

  @IsIn(FILTROS_ESTADO_ZONA)
  @IsOptional()
  estado?: 'todos' | EstadoZona;
}
