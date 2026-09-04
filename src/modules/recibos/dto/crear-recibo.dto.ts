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
  MinLength,
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
  /** Which configured tipo de documento (código, category IN) numbers this
   *  receipt — a building may have more than one, e.g. "RC" and "RT". */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

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
