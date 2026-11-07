import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /pqrs/:id/seguimientos` and `POST /portal/pqr/:id/seguimientos`.
 * There is no author field: the system this was ported from let the client name
 * the author, which allowed signing a reply as somebody else. The name is always
 * the caller's own.
 */
export class CrearSeguimientoDto {
  @IsString()
  @IsNotEmpty()
  mensaje: string;
}
