import { IsMongoId, IsOptional } from 'class-validator';

/**
 * Query for `GET /saldos-iniciales-anticipo/disponibles`. The unit is
 * optional: the Anticipos bandeja lists every unit's opening anticipos, while
 * the apply screen narrows to one.
 */
export class ListarSaldosInicialesAnticipoDisponiblesDto {
  @IsOptional()
  @IsMongoId()
  inmuebleId?: string;
}
