import { IsDateString, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/vencimientos-cartera. */
export class ConsultarVencimientosCarteraDto {
  /** Cut-off date — when omitted, defaults to now. */
  @IsOptional()
  @IsDateString()
  fecha?: string;
}
