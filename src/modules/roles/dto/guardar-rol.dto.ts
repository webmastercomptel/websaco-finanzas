// src/modules/roles/dto/guardar-rol.dto.ts
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { MAX_CLAVES_ASIGNABLES } from '../../casl/permisos-catalogo';

const COLOR_HEX = /^#[0-9a-fA-F]{6}$/;

export class CrearRolDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  nombre: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  descripcion?: string;

  @IsOptional()
  @Matches(COLOR_HEX, { message: 'color debe ser un hexadecimal como #64748b' })
  color?: string;

  /**
   * Permission keys of any offered module (Finanzas and Administración). The
   * size limit is derived from the catalogs, with room for stored keys that
   * travel back untouched; each key is at most 80 characters, as in Equipo.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CLAVES_ASIGNABLES)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permisos?: string[];

  @IsOptional()
  @IsBoolean()
  esPredeterminado?: boolean;
}

export class ActualizarRolDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  descripcion?: string;

  @IsOptional()
  @Matches(COLOR_HEX, { message: 'color debe ser un hexadecimal como #64748b' })
  color?: string;

  /**
   * Permission keys of any offered module (Finanzas and Administración). The
   * size limit is derived from the catalogs, with room for stored keys that
   * travel back untouched; each key is at most 80 characters, as in Equipo.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CLAVES_ASIGNABLES)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permisos?: string[];

  @IsOptional()
  @IsBoolean()
  esPredeterminado?: boolean;
}
