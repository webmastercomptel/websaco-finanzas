// src/modules/reservas/dto/guardar-reserva-portal.dto.ts
import {
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Body of `POST /portal/reservas`. There is no `residente` here: the name comes
 * from the caller's own account, never from the payload (the system this
 * replaces let a resident type any name and any unit). `inmueble` only SELECTS
 * one of the units the caller holds, and may be omitted when they hold one.
 */
export class CrearReservaPortalDto {
  @IsMongoId()
  @IsNotEmpty()
  espacioId: string;

  @IsISO8601()
  @IsNotEmpty()
  inicio: string;

  @IsISO8601()
  @IsNotEmpty()
  fin: string;

  @IsString()
  @IsOptional()
  inmueble?: string;

  @IsString()
  @IsOptional()
  motivo?: string;
}
