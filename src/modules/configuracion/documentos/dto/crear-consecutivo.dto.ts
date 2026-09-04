// src/modules/configuracion/documentos/dto/crear-consecutivo.dto.ts
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CrearConsecutivoDto {
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
