// src/modules/entidades/dto/guardar-entidad.dto.ts
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Everything about a managing entity except its code, all optional.
 *
 * Split the same way as CrearInmuebleDto/ActualizarInmuebleDto: creating
 * requires a code, editing does not, and a subclass cannot relax a parent's
 * required field into an optional one.
 */
class CamposEntidadDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  nit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  digitoVerificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  telefono?: string;
}

export class CrearEntidadDto extends CamposEntidadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo: string;
}

/**
 * `estado` is here, and it is the only way this record is retired: deactivating
 * a managing company suspends the access its assignments grant, without
 * touching the buildings it administers — a coproperty outlives whoever runs
 * it. There is no delete.
 */
export class ActualizarEntidadDto extends CamposEntidadDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo?: string;

  @IsOptional()
  @IsIn(['activo', 'inactivo'])
  estado?: 'activo' | 'inactivo';
}
