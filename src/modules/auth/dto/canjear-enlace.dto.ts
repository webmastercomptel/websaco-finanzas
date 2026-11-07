// src/modules/auth/dto/canjear-enlace.dto.ts
import { Matches } from 'class-validator';

/** Body of `POST /auth/enlace/canjear`: the token from the email link. */
export class CanjearEnlaceDto {
  /** 32 random bytes in hex, as `EnlaceAccesoService.construir` issues them. */
  @Matches(/^[0-9a-f]{64}$/, { message: 'El enlace no es válido' })
  token: string;
}
