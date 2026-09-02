import { IsDateString, IsMongoId, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/vencimientos-cartera. */
export class ConsultarVencimientosCarteraDto {
  @IsOptional()
  @IsMongoId()
  conceptoId?: string;

  /** Historical date of cut — when omitted, the report is "as of now". */
  @IsOptional()
  @IsDateString()
  fecha?: string;
}
