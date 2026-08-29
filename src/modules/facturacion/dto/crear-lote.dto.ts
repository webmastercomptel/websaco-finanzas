import { Type } from 'class-transformer';
import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator';

export class CrearLoteDto {
  @IsDateString()
  fechaFacturacion: string;

  @IsDateString()
  fechaVencimiento: string;

  @IsDateString()
  periodoDesde: string;

  @IsDateString()
  periodoHasta: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  descuentoProntoPago?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  diasGraciaDescuento?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  interesMora?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  topeInteresMora?: number;
}
