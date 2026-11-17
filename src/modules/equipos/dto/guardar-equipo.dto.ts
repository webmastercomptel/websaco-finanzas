import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  ESTADOS_EQUIPO,
  type EstadoEquipo,
} from '../../../database/schemas/administracion/equipo.schema';

/**
 * Body of `POST /equipos`. The tenant is never part of it: equipment always
 * belongs to the active coproperty. `@IsOptional` also lets `null` through for
 * `fechaInstalacion` and `notas`, which is how a client says "none".
 */
export class CrearEquipoDto {
  @IsString()
  @IsNotEmpty()
  nombre: string;

  @IsString()
  @IsOptional()
  tipo?: string;

  @IsString()
  @IsOptional()
  ubicacion?: string;

  @IsString()
  @IsOptional()
  marca?: string;

  @IsString()
  @IsOptional()
  modelo?: string;

  @IsString()
  @IsOptional()
  serial?: string;

  @IsISO8601()
  @IsOptional()
  fechaInstalacion?: string | null;

  @IsIn(ESTADOS_EQUIPO)
  @IsOptional()
  estado?: EstadoEquipo;

  @IsString()
  @IsOptional()
  notas?: string | null;
}
