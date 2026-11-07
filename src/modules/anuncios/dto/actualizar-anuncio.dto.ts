// src/modules/anuncios/dto/actualizar-anuncio.dto.ts
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
 * Body of `PATCH /anuncios/:id`: only the fields the client sends are changed.
 * The author is not editable (it is frozen from the creator's account).
 */
export class ActualizarAnuncioDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsOptional()
  titulo?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  @IsOptional()
  contenido?: string;

  @IsIn(CATEGORIAS_ANUNCIO)
  @IsOptional()
  categoria?: CategoriaAnuncio;

  @IsString()
  @IsOptional()
  imagen?: string | null;

  @IsBoolean()
  @IsOptional()
  destacado?: boolean;
}
