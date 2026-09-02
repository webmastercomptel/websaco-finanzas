import { IsMongoId } from 'class-validator';

/** DTO for GET /consultas/estado-cuenta/periodos */
export class ConsultarPeriodosEstadoCuentaDto {
  @IsMongoId()
  inmuebleId!: string;
}
