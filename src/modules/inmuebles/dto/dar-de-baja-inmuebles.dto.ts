// src/modules/inmuebles/dto/dar-de-baja-inmuebles.dto.ts
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The units to retire, by code. Retiring is a logical `estado` change, never a
 * delete — see `InmueblesBajaService`. The codes are trimmed BEFORE validation
 * so a cell with stray spaces still names its unit, and a blank one is
 * rejected by `MinLength` instead of silently matching nothing.
 *
 * The ceiling (1000) bounds one request's work; a roster file larger than
 * that is retired in several calls.
 */
export class DarDeBajaInmueblesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @Transform(({ value }: { value: unknown }): unknown =>
    Array.isArray(value)
      ? value.map((v: unknown) => (typeof v === 'string' ? v.trim() : v))
      : value,
  )
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  codigos: string[];
}
