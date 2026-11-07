// src/modules/mantenimientos/dto/listar-mantenimientos.dto.ts
import { IsIn, IsOptional } from 'class-validator';
import {
  ESTADOS_MANTENIMIENTO,
  TIPOS_MANTENIMIENTO,
  type EstadoMantenimiento,
  type TipoMantenimiento,
} from '../../../database/schemas/administracion/mantenimiento.schema';

/**
 * Tabs of the maintenance screen that mean "no type filter": `todos` and
 * `historial` (the frontend's catalog sends both; history is a client-side
 * view over the same rows).
 */
export const FILTROS_TIPO_MANTENIMIENTO = [
  'todos',
  'historial',
  ...TIPOS_MANTENIMIENTO,
] as const;

export const FILTROS_ESTADO_MANTENIMIENTO = [
  'todos',
  ...ESTADOS_MANTENIMIENTO,
] as const;

/**
 * Query of `GET /mantenimientos`. There is deliberately no coproperty
 * parameter: the tenant is always the active one from the request context, and
 * the global `forbidNonWhitelisted` pipe rejects a client that still sends
 * `?coPropertyId=`. Unknown values are a 400, not a silently ignored filter.
 */
export class ListarMantenimientosDto {
  @IsIn(FILTROS_TIPO_MANTENIMIENTO)
  @IsOptional()
  tipo?: 'todos' | 'historial' | TipoMantenimiento;

  @IsIn(FILTROS_ESTADO_MANTENIMIENTO)
  @IsOptional()
  estado?: 'todos' | EstadoMantenimiento;
}
