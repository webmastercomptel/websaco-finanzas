import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AplicacionSolicitadaDto } from './aplicacion-solicitada.dto';

export const MEDIOS_PAGO = [
  'transferencia',
  'cheque',
  'pse',
  'efectivo',
] as const;

export class CrearReciboDto {
  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  terceroId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  montoRecibido: number;

  @IsDateString()
  fechaRecibo: string;

  @IsIn(MEDIOS_PAGO)
  medioPago: (typeof MEDIOS_PAGO)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cuentaDestino?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  observaciones?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AplicacionSolicitadaDto)
  aplicaciones?: AplicacionSolicitadaDto[];

  @IsOptional()
  @IsBoolean()
  aplicacionAutomatica?: boolean;
}
