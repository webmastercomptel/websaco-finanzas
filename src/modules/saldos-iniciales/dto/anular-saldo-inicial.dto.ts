import { IsIn, IsString, MinLength } from 'class-validator';
import { VOID_REASONS_SALDO_INICIAL } from '../../../database/schemas/saldos-iniciales/saldo-inicial.schema';

/** No `fecha` field — unlike voiding a Factura/Recibo, this posts no
 *  accounting entry to date (the import never touches `AsientoContable`,
 *  see `SaldoInicial`'s own schema docblock), so there is nothing here for
 *  a business date to control. */
export class AnularSaldoInicialDto {
  @IsIn(VOID_REASONS_SALDO_INICIAL)
  motivo: (typeof VOID_REASONS_SALDO_INICIAL)[number];

  @IsString()
  @MinLength(20)
  detalle: string;
}
