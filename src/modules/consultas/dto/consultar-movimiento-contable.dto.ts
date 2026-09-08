import { IsDateString } from 'class-validator';

/** DTO for GET /consultas/movimiento-contable — coproperty-wide date range. */
export class ConsultarMovimientoContableDto {
  @IsDateString()
  desde!: string;

  @IsDateString()
  hasta!: string;
}
