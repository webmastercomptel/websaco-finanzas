import { IsDateString, IsMongoId, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/cartera-por-inmueble. */
export class ConsultarCarteraPorInmuebleDto {
  @IsMongoId()
  inmuebleId: string;

  /** Cut-off date — when omitted, defaults to now. */
  @IsOptional()
  @IsDateString()
  fecha?: string;
}
