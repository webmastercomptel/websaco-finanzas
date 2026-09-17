// src/modules/configuracion/documentos/dto/actualizar-consecutivo.dto.ts
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ActualizarConsecutivoDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  prefijo?: string;

  /** The last number issued under this code — 0 is valid (none issued
   *  yet). See the schema's note on `ConsecutivoDocumento.nextNumber`. */
  @IsOptional()
  @IsInt()
  @Min(0)
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
