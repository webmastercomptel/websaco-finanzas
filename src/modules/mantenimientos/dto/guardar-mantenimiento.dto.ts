// src/modules/mantenimientos/dto/guardar-mantenimiento.dto.ts
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  ESTADOS_MANTENIMIENTO,
  PERIODICIDADES_MANTENIMIENTO,
  PRIORIDADES_MANTENIMIENTO,
  TIPOS_MANTENIMIENTO,
  type EstadoMantenimiento,
  type PeriodicidadMantenimiento,
  type PrioridadMantenimiento,
  type TipoMantenimiento,
} from '../../../database/schemas/administracion/mantenimiento.schema';

/**
 * Either `tecnicoId` (picked from the technician catalog: the server resolves
 * the real name and email from it) or a free-typed `nombre` ("otro proveedor").
 * At least one is required, enforced in the service because it is an OR across
 * two optional fields.
 */
export class ProveedorMantenimientoDto {
  @IsMongoId()
  @IsOptional()
  tecnicoId?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  nombre?: string;
}

/**
 * Body of `POST /mantenimientos`. The tenant is never part of it: it comes from
 * the request context.
 */
export class CrearMantenimientoDto {
  @IsString()
  @IsNotEmpty()
  titulo: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsIn(TIPOS_MANTENIMIENTO)
  tipo: TipoMantenimiento;

  @IsIn(ESTADOS_MANTENIMIENTO)
  @IsOptional()
  estado?: EstadoMantenimiento;

  @IsIn(PRIORIDADES_MANTENIMIENTO)
  @IsOptional()
  prioridad?: PrioridadMantenimiento;

  @IsISO8601()
  fecha: string;

  @IsString()
  @IsOptional()
  horario?: string;

  @ValidateNested()
  @Type(() => ProveedorMantenimientoDto)
  proveedor: ProveedorMantenimientoDto;

  @IsString()
  @IsOptional()
  ubicacion?: string;

  @IsString()
  @IsOptional()
  notas?: string;

  @IsNumber()
  @IsOptional()
  costoEstimado?: number;

  /** `null` unlinks the equipment; absent leaves it untouched. */
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsMongoId()
  equipoId?: string | null;

  /** Only a preventive job may repeat (enforced in the service). */
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsIn(PERIODICIDADES_MANTENIMIENTO)
  periodicidad?: PeriodicidadMantenimiento | null;
}
