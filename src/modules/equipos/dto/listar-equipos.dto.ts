import { IsIn, IsOptional } from 'class-validator';
import {
  ESTADOS_EQUIPO,
  type EstadoEquipo,
} from '../../../database/schemas/administracion/equipo.schema';

/** Query of `GET /equipos`: an optional state filter. */
export class ListarEquiposDto {
  @IsIn(ESTADOS_EQUIPO)
  @IsOptional()
  estado?: EstadoEquipo;
}
