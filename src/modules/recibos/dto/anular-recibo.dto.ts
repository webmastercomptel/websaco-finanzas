import { IsIn, IsString, MinLength } from 'class-validator';

export const MOTIVOS_ANULACION_RECIBO = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;

export class AnularReciboDto {
  @IsIn(MOTIVOS_ANULACION_RECIBO)
  motivo: (typeof MOTIVOS_ANULACION_RECIBO)[number];

  // Matches the mockup's disabled-until-valid button (design §4/§7).
  @IsString()
  @MinLength(20)
  detalle: string;
}
