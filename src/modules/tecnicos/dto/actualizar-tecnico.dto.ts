import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body of `PATCH /tecnicos/:id`. Every field is optional; only the ones present
 * are written.
 */
export class ActualizarTecnicoDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  nombre?: string;

  @IsString()
  @IsOptional()
  especialidad?: string;

  @IsEmail()
  @IsOptional()
  email?: string;
}
