import { IsDateString } from 'class-validator';

/** DTO for GET /consultas/conciliacion-cartera (also bound by GET .../pdf). */
export class ConsultarConciliacionCarteraDto {
  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;
}
