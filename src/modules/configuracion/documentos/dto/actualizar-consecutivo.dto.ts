// src/modules/configuracion/documentos/dto/actualizar-consecutivo.dto.ts
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ActualizarConsecutivoDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  prefijo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  numeroSiguiente?: number;

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
