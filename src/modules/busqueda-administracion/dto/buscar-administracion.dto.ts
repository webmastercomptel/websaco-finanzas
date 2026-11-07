// src/modules/busqueda-administracion/dto/buscar-administracion.dto.ts
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
export const LIMITE_BUSQUEDA_ADMINISTRACION_POR_DEFECTO = 5;

/**
 * Query for `GET /busqueda-administracion?q=<term>&limite=<n>`.
 *
 * Deliberately the same contract as the financial `GET /busqueda` (same names,
 * same bounds), so the unified search box sends one identical query to both.
 * It is repeated instead of imported because the two products are sold
 * separately and this module must not depend on the financial one.
 *
 * `q` is trimmed BEFORE validation so padding cannot slip past the 2-character
 * floor, and the 64-character ceiling bounds the regex a hostile caller could
 * ask for. Non-strings are left untouched so `@IsString` rejects them instead
 * of a coerced value being searched. `limite` is per group and capped: a
 * dropdown never needs a page.
 */
export class BuscarAdministracionDto {
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
