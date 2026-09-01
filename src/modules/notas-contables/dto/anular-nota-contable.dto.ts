import { IsIn, IsString, MinLength } from 'class-validator';

export const MOTIVOS_ANULACION_NOTA_CONTABLE = [
  'error_digitacion',
  'error_facturacion',
  'duplicado',
  'ajuste_contrato',
  'otro',
] as const;

export class AnularNotaContableDto {
  @IsIn(MOTIVOS_ANULACION_NOTA_CONTABLE)
  motivo: (typeof MOTIVOS_ANULACION_NOTA_CONTABLE)[number];

  @IsString()
  @MinLength(20)
  detalle: string;
}
