// src/modules/configuracion/documentos/dto/actualizar-resolucion-metadata.dto.ts
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Metadata-only patch for the active ResolucionFacturacion.
 * Never touches prefix/rangeFrom/rangeTo/nextNumber/status — those fields
 * are immutable on an active resolution (spec §5).
 */
export class ActualizarResolucionMetadataDto {
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
