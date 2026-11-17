import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  ESTADOS_PQR,
  ESTADOS_PQR_LEGADOS,
} from '../../../database/schemas/administracion/pqr.schema';
import { CrearPqrPortalDto } from './guardar-pqr-portal.dto';

/**
 * Body of `POST /pqrs`: staff registering a PQR on somebody's behalf (a phone
 * call, a note at the front desk). On top of the resident's fields it carries
 * the reporter as free text: staff are not limited to
 * the units of an account, and the PQR has no author account.
 */
export class CrearPqrDto extends CrearPqrPortalDto {
  /**
   * IGNORED: every PQR is born `radicada`. Still accepted so an open old tab
   * that sends it does not get a 400.
   */
  @IsIn([...ESTADOS_PQR, ...ESTADOS_PQR_LEGADOS])
  @IsOptional()
  estado?: (typeof ESTADOS_PQR)[number] | (typeof ESTADOS_PQR_LEGADOS)[number];

  @IsString()
  @IsOptional()
  residenteNombre?: string;

  @IsString()
  @IsOptional()
  residenteRol?: string;
}
