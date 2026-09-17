import { IsDateString, IsIn, IsMongoId, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/cartera-por-conceptos/pdf. */
export class ConsultarCarteraPorConceptosPdfDto {
  /** Cut-off date — when omitted, defaults to now. */
  @IsOptional()
  @IsDateString()
  fecha?: string;

  @IsIn(['resumido', 'detallado'])
  tipo: 'resumido' | 'detallado';

  /** When given, filters to this one concepto de cobro (the "Por Concepto"
   *  tab's own layout) instead of every concept at once. */
  @IsOptional()
  @IsMongoId()
  conceptoId?: string;

  /** When given, filters to inmuebles carrying this collection status (the
   *  "Por Estado" tab's own layout) — mutually exclusive with `conceptoId`
   *  in practice (each tab sets only its own filter), but not enforced here
   *  since the report degrades gracefully if both were somehow set. */
  @IsOptional()
  @IsIn(['vigente', 'juridico', 'dificil_recaudo'])
  estado?: 'vigente' | 'juridico' | 'dificil_recaudo';
}
