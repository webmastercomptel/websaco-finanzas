import { IsDateString, IsIn, IsString, MinLength } from 'class-validator';

export const MOTIVOS_ANULACION_NOTA_ANTICIPO = [
  'error_digitacion',
  'ajuste_contrato',
  'otro',
] as const;

export class AnularNotaAnticipoDto {
  @IsIn(MOTIVOS_ANULACION_NOTA_ANTICIPO)
  motivo: (typeof MOTIVOS_ANULACION_NOTA_ANTICIPO)[number];

  @IsString()
  @MinLength(20)
  detalle: string;

  /** The date the user declares for THIS anulación — validated against the
   *  current billing period. Dates the reversing asiento; never `new Date()`. */
  @IsDateString()
  fecha: string;
}
