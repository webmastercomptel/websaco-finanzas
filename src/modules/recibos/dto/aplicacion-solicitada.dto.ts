import { Type } from 'class-transformer';
import { IsIn, IsMongoId, IsNumber, IsPositive } from 'class-validator';

/** One line of a manual cruce request — shared by CrearReciboDto (an
 *  immediate application at creation) and AplicarReciboDto (a deferred
 *  cruce), so both stay identical instead of drifting. */
export class AplicacionSolicitadaDto {
  @IsIn(['FV', 'ND'])
  tipoDocumento: 'FV' | 'ND';

  @IsMongoId()
  documentoId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  montoAplicado: number;
}
