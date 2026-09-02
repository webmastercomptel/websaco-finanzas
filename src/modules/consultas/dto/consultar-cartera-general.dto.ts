import { IsDateString, IsMongoId, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/cartera-general. */
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
}
