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
  flujoCaja?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  centroUtilidad?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  centroDestino?: string;

  @IsOptional()
  @IsBoolean()
  requiereDocumentoCruce?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  tipoImpuesto?: string;

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
