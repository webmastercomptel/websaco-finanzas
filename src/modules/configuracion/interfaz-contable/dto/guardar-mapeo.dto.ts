// src/modules/configuracion/interfaz-contable/dto/guardar-mapeo.dto.ts
import { IsEnum, IsMongoId, IsNotEmpty, IsOptional } from 'class-validator';

export class GuardarMapeoDto {
  @IsEnum(['concepto', 'especial'])
  cargoTipo: 'concepto' | 'especial';

  @IsOptional()
  @IsMongoId()
  conceptoId?: string;

  @IsOptional()
  @IsEnum(['descuentos', 'interesesOrdenDb'])
  cargoEspecial?: 'descuentos' | 'interesesOrdenDb';

  @IsMongoId()
  @IsNotEmpty()
  cuentaDebitoId: string;

  @IsMongoId()
  @IsNotEmpty()
  cuentaCreditoId: string;
}
