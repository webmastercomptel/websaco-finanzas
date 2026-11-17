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
 * Body of `PATCH /equipos/:id`. Every field is optional; only the ones present
 * are written. `null` clears `fechaInstalacion` and `notas`.
 */
export class ActualizarEquipoDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  nombre?: string;

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
