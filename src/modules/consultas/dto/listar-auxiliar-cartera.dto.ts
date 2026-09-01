import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

const TIPOS_VALIDOS = ['FC', 'RC', 'NC', 'ND', 'NT'] as const;

export class ListarAuxiliarCarteraDto {
  @IsString()
  @IsNotEmpty()
  inmuebleId!: string;

  @IsString()
  @IsNotEmpty()
  desde!: string;

  @IsString()
  @IsNotEmpty()
  hasta!: string;

  @IsOptional()
  @IsArray()
  @IsIn(TIPOS_VALIDOS, { each: true })
  tipos?: ('FC' | 'RC' | 'NC' | 'ND' | 'NT')[];
}
