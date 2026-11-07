// src/modules/actividades/dto/actualizar-actividad.dto.ts
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import {
  CATEGORIAS_ACTIVIDAD,
  ESTADOS_ACTIVIDAD,
  type CategoriaActividad,
  type EstadoActividad,
} from '../../../database/schemas/administracion/actividad.schema';

/**
 * Body of `PATCH /actividades/:id`. Every field is optional; only the ones
 * present are written. The attendee list is deliberately not editable here.
 */
export class ActualizarActividadDto {
  @IsString()
  @IsOptional()
  titulo?: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsIn(CATEGORIAS_ACTIVIDAD)
  @IsOptional()
  categoria?: CategoriaActividad;

  @IsISO8601()
  @IsOptional()
  fecha?: string;

  @IsString()
  @IsOptional()
  horario?: string;

  @IsString()
  @IsOptional()
  ubicacion?: string;

  /** `null` clears the image; omitting it leaves it untouched. */
  @IsString()
  @IsOptional()
  imagen?: string | null;

  @IsBoolean()
  @IsOptional()
  destacado?: boolean;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  capacidad?: number;

  @IsIn(ESTADOS_ACTIVIDAD)
  @IsOptional()
  estado?: EstadoActividad;

  @IsString()
  @IsOptional()
  organizador?: string;
}
