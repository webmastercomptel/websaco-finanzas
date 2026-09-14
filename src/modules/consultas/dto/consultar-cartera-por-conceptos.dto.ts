import { IsDateString, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/cartera-por-conceptos. */
export class ConsultarCarteraPorConceptosDto {
  /** Cut-off date — when omitted, defaults to now. */
  @IsOptional()
  @IsDateString()
  fecha?: string;
}
