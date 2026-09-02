import { IsDateString, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/cartera-general. */
export class ConsultarCarteraGeneralDto {
  /** Historical date of cut — when omitted, the report is "as of now". */
  @IsOptional()
  @IsDateString()
  fecha?: string;
}
