import { IsMongoId, IsDateString } from 'class-validator';

/** DTO for GET /consultas/estado-cuenta */
export class ConsultarEstadoCuentaDto {
  @IsMongoId()
  inmuebleId!: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;
}
