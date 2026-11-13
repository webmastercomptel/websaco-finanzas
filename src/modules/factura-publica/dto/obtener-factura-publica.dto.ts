// src/modules/factura-publica/dto/obtener-factura-publica.dto.ts
import { IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /publico/facturas/pdf`: the token from the e-mailed link.
 *
 * Checks the SHAPE only. A well-formed-looking string that is not a valid token
 * (wrong length, non-hex, empty) must be the same opaque 404 as an unknown one,
 * so the format check lives in the service: two observable failures (400 and
 * 404) would tell a prober which strings are worth trying. The global pipe
 * rejects any other property (`forbidNonWhitelisted`), so a body cannot name an
 * invoice or a tenant.
 */
export class ObtenerFacturaPublicaDto {
  @IsString()
  @MaxLength(128)
  token: string;
}
