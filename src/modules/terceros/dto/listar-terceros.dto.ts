// src/modules/terceros/dto/listar-terceros.dto.ts
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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
