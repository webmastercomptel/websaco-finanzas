import { IsDateString, IsMongoId, IsOptional, IsString } from 'class-validator';

/** Query DTO for GET /consultas/cartera-general (also bound by GET .../pdf,
 *  which additionally reads `version`, temporarily). */
export class ConsultarCarteraGeneralDto {
  /** Historical date of cut — when omitted, the report is "as of now". */
  @IsOptional()
  @IsDateString()
  fecha?: string;

  /**
   * Reserved for the per-concept chart's own future filter needs — not
   * consumed by any KPI today (spec §3). Declared now so the contract
   * doesn't need a breaking change later.
   */
  @IsOptional()
  @IsMongoId()
  conceptoId?: string;

  /** TEMPORARY — pdf-lib -> react-pdf migration QA toggle. Remove along
   *  with the controller's `version` handling once react-pdf takes over. */
  @IsOptional()
  @IsString()
  version?: string;
}
