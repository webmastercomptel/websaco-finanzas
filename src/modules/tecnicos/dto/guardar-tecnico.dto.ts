import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body of `POST /tecnicos`. The tenant is never part of it: a technician always
 * belongs to the active coproperty.
 */
export class CrearTecnicoDto {
  @IsString()
  @IsNotEmpty()
  nombre: string;

  @IsString()
  @IsOptional()
  especialidad?: string;

  @IsEmail()
  @IsOptional()
  email?: string;
}
