import { IsDateString, IsOptional, IsString } from 'class-validator';

/** DTO for GET /consultas/conciliacion-cartera (also bound by GET .../pdf,
 *  which additionally reads `version`, temporarily). */
export class ConsultarConciliacionCarteraDto {
  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  /** TEMPORARY — pdf-lib -> react-pdf migration QA toggle. Remove along
   *  with the controller's `version` handling once react-pdf takes over. */
  @IsOptional()
  @IsString()
  version?: string;
}
