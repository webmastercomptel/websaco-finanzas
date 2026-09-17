import { IsIn, IsString, MinLength } from 'class-validator';
import { VOID_REASONS_SALDO_INICIAL_ANTICIPO } from '../../../database/schemas/saldos-iniciales/saldo-inicial-anticipo.schema';

/** No `fecha` field — same reasoning as `AnularSaldoInicialDto`: this import
 *  never posts to `AsientoContable`, so there is no business date for an
 *  anulación to control. */
export class AnularSaldoInicialAnticipoDto {
  @IsIn(VOID_REASONS_SALDO_INICIAL_ANTICIPO)
  motivo: (typeof VOID_REASONS_SALDO_INICIAL_ANTICIPO)[number];

  @IsString()
  @MinLength(20)
  detalle: string;
}
