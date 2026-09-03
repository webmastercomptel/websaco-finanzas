// src/modules/configuracion/parametros/dto/actualizar-parametros.dto.ts
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * What `PATCH /parametros-facturacion` accepts. Every field optional — only
 * the keys a caller actually sends are applied (see
 * ParametrosService.update's `set()` helper).
 */
export class ActualizarParametrosDto {
  @IsOptional()
  @IsBoolean()
  descuentoHabilitado?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  porcentajeDescuento?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  valorFijoDescuento?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  diasGraciaDescuento?: number;

  @IsOptional()
  @IsBoolean()
  descuentoAplicaConMora?: boolean;

  @IsOptional()
  @IsBoolean()
  moraHabilitada?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tasaInteresMora?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  topeValorMora?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cuentaBancoPredeterminada?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  observacionesFacturacion?: string | null;
}
