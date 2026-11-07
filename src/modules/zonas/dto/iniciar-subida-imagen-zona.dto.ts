// src/modules/zonas/dto/iniciar-subida-imagen-zona.dto.ts
import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

/**
 * Body of the first step of a common area's image upload: declares the file so
 * the backend can sign a write URL pinned to exactly that content type.
 */
export class IniciarSubidaImagenZonaDto {
  @IsString()
  @IsNotEmpty()
  nombre: string;

  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @IsInt()
  @Min(1)
  tamanoBytes: number;
}
