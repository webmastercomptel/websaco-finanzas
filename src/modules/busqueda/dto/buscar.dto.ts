// src/modules/busqueda/dto/buscar.dto.ts
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Hits per group when the client does not ask for a number. */
export const LIMITE_BUSQUEDA_POR_DEFECTO = 5;

/**
 * Query for `GET /busqueda?q=<term>&limite=<n>`.
 *
 * `q` is trimmed BEFORE validation so "  a " cannot slip past the minimum
 * length as three characters, and so the regex built from it matches what
 * the person typed rather than its padding. The 2-character floor keeps a
 * single keystroke from scanning every document of the building; the
 * 64-character ceiling bounds the regex a hostile caller could ask for.
 * Non-strings are left untouched so `@IsString` rejects them instead of a
 * coerced value being searched.
 *
 * `limite` is per group and capped: a global-search dropdown never needs a
 * page, and an unbounded value would turn one keystroke into a table scan
 * across six collections.
 */
export class BuscarDto {
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limite?: number;
}
