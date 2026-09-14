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
}
