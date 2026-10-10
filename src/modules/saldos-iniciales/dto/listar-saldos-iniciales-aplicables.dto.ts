import { IsMongoId } from 'class-validator';

/**
 * Query for `GET /saldos-iniciales/aplicables`. The unit is REQUIRED: the
 * payment flows (Recibo, Nota Crédito, Anticipo) always work against one
 * unit's cartera, so an unscoped call would just be an admin listing by the
 * back door.
 */
export class ListarSaldosInicialesAplicablesDto {
  @IsMongoId()
  inmuebleId!: string;
}
