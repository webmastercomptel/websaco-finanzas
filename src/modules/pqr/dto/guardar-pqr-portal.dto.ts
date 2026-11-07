import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import {
  PRIORIDADES_PQR_ENTRADA,
  TIPOS_PQR,
  type TipoPqr,
} from '../../../database/schemas/administracion/pqr.schema';

/**
 * Body of `POST /portal/pqr`: what a resident may say about their own report.
 *
 * Deliberately absent: the status (it always starts `pendiente`), the reporter's
 * name and role (taken from the account and the unit they hold) and the
 * technician. `unidad` is the unit CODE and must be one of the caller's own
 * units; the service rejects any other. It may be omitted only by a resident who
 * holds exactly one unit.
 *
 * It is also the base of the staff body, which adds the fields only staff may
 * set.
 */
export class CrearPqrPortalDto {
  @IsString()
  @IsNotEmpty()
  titulo: string;

  @IsString()
  @IsNotEmpty()
  descripcion: string;

  @IsString()
  @IsOptional()
  descripcionCompleta?: string;

  @IsString()
  @IsOptional()
  categoria?: string;

  @IsIn(TIPOS_PQR)
  tipo: TipoPqr;

  /** `urgente` is a legacy alias normalized to `alta` (it is a status, not a priority). */
  @IsIn(PRIORIDADES_PQR_ENTRADA)
  @IsOptional()
  prioridad?: (typeof PRIORIDADES_PQR_ENTRADA)[number];

  @IsString()
  @IsOptional()
  unidad?: string;
}
