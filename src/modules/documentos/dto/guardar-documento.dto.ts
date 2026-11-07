import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** `type/subtype` with the characters a real MIME type uses; nothing else is signed for. */
export const PATRON_MIME = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * Body of step 1 of an upload: declares the file so the backend can register it
 * as `pendiente` and sign a write URL for exactly that content type. The size
 * limit and the folder permission are checked in the service, after the folder
 * is known to exist.
 */
export class CrearDocumentoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nombre: string;

  @IsString()
  @Matches(PATRON_MIME, { message: 'mimeType no es un tipo MIME válido' })
  @MaxLength(127)
  mimeType: string;

  /** Slug of the destination folder. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  carpeta: string;

  @IsInt()
  @Min(1)
  tamanoBytes: number;

  @IsString()
  @IsOptional()
  @MaxLength(60)
  categoria?: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  etiquetas?: string[];
}
