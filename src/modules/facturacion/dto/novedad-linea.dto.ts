import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** A charge line can never be negative — a negative line would seed a
 *  negative `CarteraPorDocumento.saldoPendiente` at consolidación. Money in
 *  the unit's favour is an anticipo, never a negative cargo. */
const MENSAJE_MONTO_NEGATIVO =
  'El monto de un cargo no puede ser negativo; un saldo a favor se registra como anticipo';

export class AgregarNovedadLineaDto {
  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  conceptoId: string;

  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(0, { message: MENSAJE_MONTO_NEGATIVO })
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /**
   * Set only when this line must REPLACE what construirPreview() would
   * otherwise compute from ValorRecurrente ('recurrente') or from the mora
   * formula ('interes') for this same inmueble+concepto, instead of adding a
   * separate line. Omitted (or absent), the charge is additive — the
   * ordinary Excel/manual case.
   */
  @IsOptional()
  @IsIn(['recurrente', 'interes'])
  overrides?: 'recurrente' | 'interes';
}

export class EditarNovedadLineaDto {
  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(0, { message: MENSAJE_MONTO_NEGATIVO })
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
