// src/modules/configuracion/cuentas-contables/dto/guardar-cuenta.dto.ts
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

class CamposCuentaDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsBoolean()
  requiereTercero?: boolean;

  @IsOptional()
  @IsBoolean()
  esBanco?: boolean;

  @IsOptional()
  @IsBoolean()
  flujoCaja?: boolean;

  @IsOptional()
  @IsBoolean()
  centroUtilidad?: boolean;

  @IsOptional()
  @IsBoolean()
  centroDestino?: boolean;

  @IsOptional()
  @IsBoolean()
  requiereDocumentoCruce?: boolean;

  @IsOptional()
  @IsBoolean()
  aplicaImpuesto?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  tasaImpuesto?: number;
}

export class CrearCuentaDto extends CamposCuentaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo: string;
}

export class ActualizarCuentaDto extends CamposCuentaDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo?: string;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
