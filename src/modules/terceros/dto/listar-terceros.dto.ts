// src/modules/terceros/dto/listar-terceros.dto.ts
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Query parameters for the party listing.
 *
 * Every field is optional and every one has a sane default, because a
 * listing must answer a bare GET. See ListarInmueblesDto for why a typo in a
 * parameter name is a 400, not a filter that silently does nothing.
 */
export class ListarTercerosDto {
  /** Matches name or identification number. */
  @IsOptional()
  @IsString()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  buscar?: string;

  /**
   * Exact e-mail match against ANY address of the party. Lets the unit form
   * ask the server whether a tenant's address is already taken instead of
   * downloading a page of parties and comparing in the browser (which misses
   * everyone past the page). Trimmed and lower-cased here; a non-string is
   * passed through untouched so the validators reject it instead of it
   * reaching the filter as an operator object.
   */
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MaxLength(120)
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(['activo', 'inactivo', 'todos'])
  estado?: 'activo' | 'inactivo' | 'todos';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  porPagina?: number;
}
