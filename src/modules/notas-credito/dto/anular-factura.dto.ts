import {
  IsDateString,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Same catalog as `AnularNotaCreditoDto`'s — declared independently, same
 *  precedent as every other document type's own void-reason list. */
export const MOTIVOS_ANULACION_FACTURA = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;

export class AnularFacturaDto {
  @IsIn(MOTIVOS_ANULACION_FACTURA)
  motivo: (typeof MOTIVOS_ANULACION_FACTURA)[number];

  // Matches the mockup's disabled-until-valid button, same as
  // AnularNotaCreditoDto/AnularReciboDto.
  @IsString()
  @MinLength(20)
  detalle: string;

  /** Dates both the invoice's void and the Nota Crédito this creates behind
   *  the scenes — validated against the current billing period exactly like
   *  `AnularNotaCreditoDto.fecha`. */
  @IsDateString()
  fecha: string;

  /** Which configured tipo de documento (código, category NC) numbers the
   *  Nota Crédito this anulación creates — same field `CrearNotaCreditoDto`
   *  asks for, since voiding a Factura always goes through that same path. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;
}
