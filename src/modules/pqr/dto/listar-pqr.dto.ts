import { IsIn, IsOptional } from 'class-validator';
import {
  ESTADOS_PQR,
  TIPOS_PQR,
  type EstadoPqr,
  type TipoPqr,
} from '../../../database/schemas/administracion/pqr.schema';

export const FILTROS_TIPO_PQR = ['todos', ...TIPOS_PQR] as const;
export const FILTROS_ESTADO_PQR = ['todos', ...ESTADOS_PQR] as const;

/**
 * Query of both PQR lists (staff and resident portal). There is deliberately no
 * coproperty parameter: the tenant is always the active one, and the global
 * `forbidNonWhitelisted` pipe rejects a client that still sends it. Unknown
 * values are a 400, not a silently ignored filter.
 */
export class ListarPqrDto {
  @IsIn(FILTROS_TIPO_PQR)
  @IsOptional()
  tipo?: 'todos' | TipoPqr;

  @IsIn(FILTROS_ESTADO_PQR)
  @IsOptional()
  estado?: 'todos' | EstadoPqr;
}
