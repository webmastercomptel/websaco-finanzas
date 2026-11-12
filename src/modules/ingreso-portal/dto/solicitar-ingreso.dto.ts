// src/modules/ingreso-portal/dto/solicitar-ingreso.dto.ts
import { IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /auth/portal/solicitar`: the address the person typed.
 *
 * Checks the SHAPE only: a string of at most 320 characters (the longest an
 * address can be). Whether it is an address, is on a record or is revoked is
 * never a validation error: every string in this shape gets the same 202, so a
 * 400 must not tell a prober which strings are worth trying. The global pipe
 * rejects any other property (`forbidNonWhitelisted`).
 */
export class SolicitarIngresoDto {
  @IsString()
  @MaxLength(320)
  correo: string;
}
