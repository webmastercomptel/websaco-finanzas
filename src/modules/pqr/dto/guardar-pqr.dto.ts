import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  ESTADOS_PQR_ASIGNABLES,
  type EstadoPqr,
} from '../../../database/schemas/administracion/pqr.schema';
import { CrearPqrPortalDto } from './guardar-pqr-portal.dto';

/**
 * Body of `POST /pqrs`: staff registering a PQR on somebody's behalf (a phone
 * call, a note at the front desk). On top of the resident's fields it carries
 * the initial status and the reporter as free text: staff are not limited to
 * the units of an account, and the PQR has no author account.
 */
export class CrearPqrDto extends CrearPqrPortalDto {
  @IsIn(ESTADOS_PQR_ASIGNABLES)
  @IsOptional()
  estado?: Exclude<EstadoPqr, 'cerrado'>;

  @IsString()
  @IsOptional()
  residenteNombre?: string;

  @IsString()
  @IsOptional()
  residenteRol?: string;
}
