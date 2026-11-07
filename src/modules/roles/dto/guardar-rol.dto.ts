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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permisos?: string[];

  @IsOptional()
  @IsBoolean()
  esPredeterminado?: boolean;
}
