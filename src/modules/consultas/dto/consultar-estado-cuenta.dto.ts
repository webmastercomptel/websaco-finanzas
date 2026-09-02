import {
  IsBooleanString,
  IsDateString,
  IsMongoId,
  IsOptional,
} from 'class-validator';

/** DTO for GET /consultas/estado-cuenta (also bound by GET .../pdf, which
 *  additionally reads `duplicado` — declared here since the global
 *  ValidationPipe's `forbidNonWhitelisted` rejects any query param this
 *  DTO doesn't know about). */
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
}
