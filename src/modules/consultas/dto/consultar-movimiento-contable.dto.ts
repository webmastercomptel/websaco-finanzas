import { IsDateString, IsMongoId } from 'class-validator';

/** DTO for GET /consultas/movimiento-contable — browse by inmueble + date range. */
export class ConsultarMovimientoContableDto {
  @IsMongoId()
  inmuebleId!: string;

  @IsDateString()
  desde!: string;

  @IsDateString()
  hasta!: string;
}
