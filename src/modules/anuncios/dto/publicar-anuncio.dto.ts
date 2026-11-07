// src/modules/anuncios/dto/publicar-anuncio.dto.ts
import { ArrayUnique, IsArray, IsIn, IsOptional } from 'class-validator';
import {
  CANALES_ANUNCIO,
  type CanalAnuncio,
} from '../../../database/schemas/administracion/anuncio.schema';

/**
 * Body of `POST /anuncios/:id/publicar`. Email is the only channel that was ever
 * wired up, so it is the only value accepted: SMS, WhatsApp and push answer 400
 * instead of being silently ignored (the system this replaces accepted them and
 * sent nothing). The list is optional and does not change behaviour; it exists
 * so a client written against the old contract (`canales: ['email']`) keeps
 * working. The old `rolesDestino` is not accepted: it was stored but never
 * filtered anything.
 */
export class PublicarAnuncioDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(CANALES_ANUNCIO, { each: true })
  @IsOptional()
  canales?: CanalAnuncio[];
}
