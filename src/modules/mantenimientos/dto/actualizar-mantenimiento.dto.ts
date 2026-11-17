// src/modules/mantenimientos/dto/actualizar-mantenimiento.dto.ts
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsMongoId,
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
import { ProveedorMantenimientoDto } from './guardar-mantenimiento.dto';

/**
 * Body of `PATCH /mantenimientos/:id`. Every field is optional; only the ones
 * present are written. `proveedor`, when sent, is re-resolved against the
 * technician catalog.
 */
export class ActualizarMantenimientoDto {
  @IsString()
  @IsOptional()
  titulo?: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsIn(TIPOS_MANTENIMIENTO)
  @IsOptional()
  tipo?: TipoMantenimiento;

  @IsIn(ESTADOS_MANTENIMIENTO)
  @IsOptional()
  estado?: EstadoMantenimiento;

  @IsIn(PRIORIDADES_MANTENIMIENTO)
  @IsOptional()
  prioridad?: PrioridadMantenimiento;

  @IsISO8601()
  @IsOptional()
  fecha?: string;

  @IsString()
  @IsOptional()
  horario?: string;

  @ValidateNested()
  @Type(() => ProveedorMantenimientoDto)
  @IsOptional()
  proveedor?: ProveedorMantenimientoDto;

  @IsString()
  @IsOptional()
  ubicacion?: string;

  @IsString()
  @IsOptional()
  notas?: string;

  @IsNumber()
  @IsOptional()
  costoEstimado?: number;

  @IsISO8601()
  @IsOptional()
  completadoEn?: string;

  /** `null` unlinks the equipment; absent leaves it untouched. */
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsMongoId()
  equipoId?: string | null;

  /** Only a preventive job may repeat (enforced in the service). */
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsIn(PERIODICIDADES_MANTENIMIENTO)
  periodicidad?: PeriodicidadMantenimiento | null;
}
