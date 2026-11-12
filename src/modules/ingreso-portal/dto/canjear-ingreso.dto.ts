// src/modules/ingreso-portal/dto/canjear-ingreso.dto.ts
import { IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /auth/portal/canjear`: the token from the sign-in link.
 *
 * Checks the SHAPE only. A string that is not a well-formed token (wrong length,
 * non-hex) must be the same opaque 401 as an unknown one, so the format check
 * lives in the controller: two observable failures (400 and 401) would tell a
 * prober which strings are worth trying.
 */
export class CanjearIngresoDto {
  @IsString()
  @MaxLength(128)
  token: string;
}
