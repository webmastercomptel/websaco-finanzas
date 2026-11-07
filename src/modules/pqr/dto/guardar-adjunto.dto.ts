import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

/**
 * Body of the first step of an attachment upload: declares the file so the
 * backend can register it as `pendiente` and sign a write URL for exactly that
 * content type.
 */
export class CrearAdjuntoPqrDto {
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
