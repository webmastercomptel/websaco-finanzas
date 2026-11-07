// src/modules/anuncios/dto/guardar-anuncio.dto.ts
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  CATEGORIAS_ANUNCIO,
  type CategoriaAnuncio,
} from '../../../database/schemas/administracion/anuncio.schema';

/**
 * Body of `POST /anuncios`. Neither the tenant nor the author is part of it: the
 * author is the caller's own account name, so a client cannot sign an
 * announcement as somebody else (the global `forbidNonWhitelisted` pipe answers
 * 400 to a client that still sends `autor`).
 */
export class CrearAnuncioDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  titulo: string;

  /** Plain text; line breaks survive into the email. `{{nombre}}` is personalized per resident. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  contenido: string;

  @IsIn(CATEGORIAS_ANUNCIO)
  categoria: CategoriaAnuncio;

  /** `null` is accepted (and stored) as "no image"; omitting it does the same. */
  @IsString()
  @IsOptional()
  imagen?: string | null;

  @IsBoolean()
  @IsOptional()
  destacado?: boolean;
}
