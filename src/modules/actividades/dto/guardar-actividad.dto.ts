// src/modules/actividades/dto/guardar-actividad.dto.ts
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
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
 * Body of `POST /actividades`. The tenant is never part of it, nor is the
 * attendee list: signing up goes through the resident portal, never through the
 * administrator's form.
 */
export class CrearActividadDto {
  @IsString()
  @IsNotEmpty()
  titulo: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsIn(CATEGORIAS_ACTIVIDAD)
  categoria: CategoriaActividad;

  @IsISO8601()
  fecha: string;

  @IsString()
  @IsOptional()
  horario?: string;

  @IsString()
  @IsOptional()
  ubicacion?: string;

  /** `null` is accepted (and stored) as "no image"; omitting it does the same. */
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

  /** 0 means nobody can register, not "unlimited". */
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
