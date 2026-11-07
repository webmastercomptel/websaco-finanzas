// src/modules/acceso-residentes/dto/crear-acceso-residente.dto.ts
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Body of `POST /residentes/:terceroId/acceso`.
 *
 * There is NO email field and that is deliberate: the address always comes from
 * the party's own record. Letting the caller type one would let anyone holding
 * `usuarios.crear` (an Administración key) point a resident's invoices at an
 * inbox of their choosing, which is read access to financial data they were
 * never granted. Correcting an address is a Terceros edit.
 */
export class CrearAccesoResidenteDto {
  /**
   * Explicit consent to link an account that ALREADY exists for the party's
   * address. Without it an existing account is a 409, never a silent takeover.
   */
  @IsOptional()
  @IsBoolean()
  vincularExistente?: boolean;
}
