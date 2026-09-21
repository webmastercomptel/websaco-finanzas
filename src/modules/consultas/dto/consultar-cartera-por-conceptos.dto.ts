import { IsDateString, IsIn, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/cartera-por-conceptos. */
export class ConsultarCarteraPorConceptosDto {
  /** Cut-off date — when omitted, defaults to now. */
  @IsOptional()
  @IsDateString()
  fecha?: string;

  /** Filters which units feed all 3 tabs by `Inmueble.estado` (soft
   *  retire, not `collectionStatus`) — omitted means every unit,
   *  active and inactive alike. */
  @IsOptional()
  @IsIn(['activo', 'inactivo'])
  estadoInmueble?: 'activo' | 'inactivo';
}
