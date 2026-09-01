import { IsIn, IsString, MinLength } from 'class-validator';

export const MOTIVOS_ANULACION_NOTA_DEBITO = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;

export class AnularNotaDebitoDto {
  @IsIn(MOTIVOS_ANULACION_NOTA_DEBITO)
  motivo: (typeof MOTIVOS_ANULACION_NOTA_DEBITO)[number];

  @IsString()
  @MinLength(20)
  detalle: string;
}
