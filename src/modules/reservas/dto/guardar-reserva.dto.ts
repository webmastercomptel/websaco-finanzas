// src/modules/reservas/dto/guardar-reserva.dto.ts
import {
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Body of `POST /reservas` (staff registering a booking on somebody's behalf).
 * The tenant is never part of it, and neither is the author account: a booking
 * registered here belongs to nobody's account. `residente` and `inmueble` are
 * free text because staff may book for people or units that have no account.
 */
export class CrearReservaDto {
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
  residente?: string;

  @IsString()
  @IsOptional()
  inmueble?: string;

  @IsString()
  @IsOptional()
  motivo?: string;
}
