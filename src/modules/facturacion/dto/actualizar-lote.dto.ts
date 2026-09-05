import { Type } from 'class-transformer';
import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * Edits a run's own definition — every field the "Definición de Períodos"
 * screen shows, all optional since this is a patch, not a replace. Refused
 * by `LotesFacturacionService.actualizar` once the lote is consolidado (see
 * its own note); reachable up to that point precisely because a mistake
 * caught mid-liquidación (wrong dates, a stale Parámetros snapshot) should
 * not force cancelling the whole run and starting over.
 */
export class ActualizarLoteDto {
  @IsOptional()
  @IsDateString()
  fechaFacturacion?: string;

  @IsOptional()
  @IsDateString()
  fechaVencimiento?: string;

  @IsOptional()
  @IsDateString()
  periodoDesde?: string;

  @IsOptional()
  @IsDateString()
  periodoHasta?: string;

  @IsOptional()
  @IsDateString()
  fechaLimiteDescuento?: string;

  @IsOptional()
  @IsDateString()
  fechaSuspension?: string;

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
