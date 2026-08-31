import { IsIn, IsString, MinLength } from 'class-validator';

export const MOTIVOS_ANULACION_NOTA_CREDITO = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;

export class AnularNotaCreditoDto {
  @IsIn(MOTIVOS_ANULACION_NOTA_CREDITO)
  motivo: (typeof MOTIVOS_ANULACION_NOTA_CREDITO)[number];

  // Matches the mockup's disabled-until-valid button, same as AnularReciboDto.
  @IsString()
  @MinLength(20)
  detalle: string;
}
