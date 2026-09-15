import {
  IsBooleanString,
  IsDateString,
  IsMongoId,
  IsOptional,
  IsString,
} from 'class-validator';

/** DTO for GET /consultas/estado-cuenta (also bound by GET .../pdf, which
 *  additionally reads `duplicado` and, temporarily, `version` — declared
 *  here since the global ValidationPipe's `forbidNonWhitelisted` rejects
 *  any query param this DTO doesn't know about). */
export class ConsultarEstadoCuentaDto {
  @IsMongoId()
  inmuebleId!: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  @IsOptional()
  @IsBooleanString()
  duplicado?: string;

  /** TEMPORARY — pdf-lib -> react-pdf migration QA toggle. Remove along
   *  with the controller's `version` handling once react-pdf takes over. */
  @IsOptional()
  @IsString()
  version?: string;
}
