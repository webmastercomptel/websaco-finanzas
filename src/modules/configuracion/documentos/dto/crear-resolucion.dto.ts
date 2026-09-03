// src/modules/configuracion/documentos/dto/crear-resolucion.dto.ts
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CrearResolucionDto {
  @IsString()
  @MaxLength(60)
  numeroResolucion: string;

  @IsString()
  @MaxLength(20)
  prefijo: string;

  @IsInt()
  @Min(1)
  rangoDesde: number;

  @IsInt()
  @Min(1)
  rangoHasta: number;

  @IsDateString()
  vigenciaDesde: string;

  @IsOptional()
  @IsDateString()
  vigenciaHasta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombreDocumento?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  comprobanteContable?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  numeroElectronico?: number;
}
