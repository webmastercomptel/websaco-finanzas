import { IsDateString, IsIn, IsMongoId, IsOptional } from 'class-validator';
import type { RangoVencimiento } from '../../../contracts';

const RANGOS_VALIDOS: RangoVencimiento[] = [
  'sinVencer',
  'dias_1_30',
  'dias_31_60',
  'dias_61_90',
  'dias_91_120',
  'dias_121_180',
  'dias_181_360',
  'dias_361_720',
  'dias_720_mas',
];

/** Query DTO for GET /consultas/vencimientos-cartera/pdf. */
export class ConsultarVencimientosCarteraPdfDto {
  /** Cut-off date — when omitted, defaults to now. */
  @IsOptional()
  @IsDateString()
  fecha?: string;

  /** Filters to one inmueble — the on-screen filter's own PDF export. */
  @IsOptional()
  @IsMongoId()
  inmuebleId?: string;

  /** Filters to one aging bucket — the on-screen filter's own PDF export. */
  @IsOptional()
  @IsIn(RANGOS_VALIDOS)
  rango?: RangoVencimiento;
}
