// src/modules/zonas/dto/actualizar-zona.dto.ts
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ESTADOS_ZONA,
  TIPOS_ZONA,
  type EstadoZona,
  type TipoZona,
} from '../../../database/schemas/administracion/zona.schema';

/**
 * Body of `PATCH /zonas-comunes/:id`. Every field is optional; only the ones
 * present are written. The image has its own two-step upload, but a URL may
 * still be set or cleared here (`null`), as before.
 */
export class ActualizarZonaDto {
  @IsString()
  @IsOptional()
  nombre?: string;

  @IsIn(TIPOS_ZONA)
  @IsOptional()
  tipo?: TipoZona;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  capacidad?: number;

  @IsString()
  @IsOptional()
  horario?: string;

  @IsBoolean()
  @IsOptional()
  requiereReserva?: boolean;

  @ValidateIf((_, valor) => valor !== null)
  @IsNumber()
  @IsOptional()
  costo?: number | null;

  @IsString()
  @IsOptional()
  imagen?: string | null;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  reglas?: string[];

  @IsIn(ESTADOS_ZONA)
  @IsOptional()
  estado?: EstadoZona;
}
