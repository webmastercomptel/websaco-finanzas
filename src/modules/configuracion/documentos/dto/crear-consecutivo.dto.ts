// src/modules/configuracion/documentos/dto/crear-consecutivo.dto.ts
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CrearConsecutivoDto {
  /** The client-facing type code, e.g. "RC", "RT", "CI" — unique per
   *  building, across every category. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  prefijo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  numeroInicial?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombreDocumento?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  comprobanteContable?: string;
}
