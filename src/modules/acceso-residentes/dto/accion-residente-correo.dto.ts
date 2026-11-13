// src/modules/acceso-residentes/dto/accion-residente-correo.dto.ts
import { IsString, Matches } from 'class-validator';

/**
 * Body of `POST /residentes/correos/{reenviar|revocar|permitir}`: the pair a row
 * of the list names. There is deliberately NO address field: the service
 * re-resolves it from the party's own record in the active coproperty, so a
 * caller can never aim an action (or a sign-in e-mail) at an address of their
 * choosing. Both ids are checked by exact shape (`@IsMongoId` lets a `0x`
 * prefix through).
 */
export class AccionResidenteCorreoDto {
  @IsString()
  @Matches(/^[0-9a-f]{24}$/i, { message: 'terceroId debe ser un id válido' })
  terceroId: string;

  /** `claveCorreo(address)`: 64 lowercase hex characters. */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'clave debe ser una clave válida' })
  clave: string;
}
