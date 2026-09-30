import { IsDateString, IsIn, IsOptional } from 'class-validator';

/** Query DTO for GET /consultas/vencimientos-cartera. */
export class ConsultarVencimientosCarteraDto {
  /** Cut-off date — when omitted, defaults to now. */
  @IsOptional()
  @IsDateString()
  fecha?: string;

  /** Filters which units feed the report by `Inmueble.status` (soft
   *  retire, not `collectionStatus`), applied before any other filter —
   *  omitted means every unit, active and inactive alike. Same semantics
   *  as Cartera por Conceptos' own `estadoInmueble`. */
  @IsOptional()
  @IsIn(['activo', 'inactivo'])
  estadoInmueble?: 'activo' | 'inactivo';

  /** Filters by the unit's `collectionStatus`, applied right after
   *  `estadoInmueble` — omitted means every collection status. */
  @IsOptional()
  @IsIn(['vigente', 'juridico', 'dificil_recaudo'])
  estadoCartera?: 'vigente' | 'juridico' | 'dificil_recaudo';
}
