import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class AgregarNovedadLineaDto {
  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  conceptoId: string;

  @Type(() => Number)
  @IsNumber()
  @IsInt()
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
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
