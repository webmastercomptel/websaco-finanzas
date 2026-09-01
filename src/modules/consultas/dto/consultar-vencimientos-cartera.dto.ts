import { IsMongoId, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/vencimientos-cartera. */
export class ConsultarVencimientosCarteraDto {
  @IsOptional()
  @IsMongoId()
  conceptoId?: string;
}
