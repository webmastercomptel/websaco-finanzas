import { Type } from 'class-transformer';
import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * Every date and every mora/descuento parameter here is a SNAPSHOT: the
 * "Definición de Períodos" screen pre-fills all of them (dates computed from
 * the billing month, rates/días from Parámetros de Facturación) but a
 * coproperty admin may edit any of them before submitting, without touching
 * the standing Copropiedad record — same reasoning `LoteFacturacion`'s own
 * class docstring gives for `earlyPaymentDiscount`/`lateInterestRate`.
 */
export class CrearLoteDto {
  @IsDateString()
  fechaFacturacion: string;

  @IsDateString()
  fechaVencimiento: string;

  @IsDateString()
  periodoDesde: string;

  @IsDateString()
  periodoHasta: string;

  /** Defaults to `fechaFacturacion + diasGraciaDescuento - 1 día` when
   *  omitted — see `LotesFacturacionService.crear()`. */
  @IsOptional()
  @IsDateString()
  fechaLimiteDescuento?: string;

  /** Defaults to `periodoHasta` when omitted. */
  @IsOptional()
  @IsDateString()
  fechaSuspension?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  descuentoProntoPago?: number;

  /** Mutually exclusive with `descuentoProntoPago` in practice (Parámetros
   *  de Facturación's own rule: a fixed value only applies when there is no
   *  percentage) — see `LotesFacturacionService.crear()`'s inheritance and
   *  `calcularDescuentoProntoPago`'s own precedence. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  valorFijoDescuentoProntoPago?: number;

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
