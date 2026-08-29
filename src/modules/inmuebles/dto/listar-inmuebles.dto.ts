// src/modules/inmuebles/dto/listar-inmuebles.dto.ts
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query parameters for the unit listing.
 *
 * Every field is optional and every one has a sane default, because a listing
 * must answer a bare GET. The global ValidationPipe runs with
 * `forbidNonWhitelisted`, so a typo in a parameter name is a 400 rather than a
 * filter that silently does nothing — which is the failure mode that has people
 * staring at a full list wondering why their search did not apply.
 */
export class ListarInmueblesDto {
  /** Matches unit code or holder name. */
  @IsOptional()
  @IsString()
  // `value` is typed `any` by class-transformer, so it is narrowed here rather
  // than handed straight back — returning it untouched would leak `any` into a
  // field the rest of the code trusts to be a string.
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

  /**
   * Capped deliberately. Without a ceiling, one call asking for everything is a
   * denial of service somebody triggers by accident.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  porPagina?: number;
}
