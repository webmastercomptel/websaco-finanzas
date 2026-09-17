import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  ValidateNested,
} from 'class-validator';
import { DistribucionLineaDto } from '../../notas-credito/dto/distribucion-linea.dto';

/** One line of a manual cruce request — shared by CrearReciboDto (an
 *  immediate application at creation) and AplicarReciboDto (a deferred
 *  cruce), so both stay identical instead of drifting. */
export class AplicacionSolicitadaDto {
  @IsIn(['FV', 'ND', 'SI'])
  tipoDocumento: 'FV' | 'ND' | 'SI';

  @IsMongoId()
  documentoId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  montoAplicado: number;

  /**
   * How this abono is split across the target Factura's own conceptos —
   * e.g. "all of it to intereses, none to administración". Only meaningful
   * for `tipoDocumento: 'FV'` — a Nota Débito has a single concepto, nothing
   * to choose (`ejecutarAplicacionManual` rejects it there). Optional: when
   * omitted, the target's own default cascade applies (unchanged behavior).
   * Reuses Nota Crédito's own `DistribucionLineaDto` — same shape, same
   * "sums to the total, capped per concepto" validation family (see
   * `validarDistribucionManual` in `cruce.util.ts`), just capped against
   * what's genuinely still pending instead of the invoice's frozen total.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DistribucionLineaDto)
  distribucion?: DistribucionLineaDto[];
}
