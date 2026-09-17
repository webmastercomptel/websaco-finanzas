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

  /** Last number already issued under this code before this row existed —
   *  0 (the default applied when omitted) means none yet, so the next
   *  document issued gets number 1. See the schema's note on `nextNumber`. */
  @IsOptional()
  @IsInt()
  @Min(0)
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
