import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/** A query-string boolean arrives as the literal string "true"/"false" —
 *  `Boolean("false")` is `true` in JS, so this cannot use `@Type(() =>
 *  Boolean)` like the numeric fields below use `@Type(() => Number)`. */
const aBooleano = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
};

export class ListarRecibosDto {
  @IsOptional()
  @IsMongoId()
  inmuebleId?: string;

  @IsOptional()
  @IsIn(['activo', 'anulado'])
  estado?: 'activo' | 'anulado';

  @IsOptional()
  @IsDateString()
  desde?: string;

  @IsOptional()
  @IsDateString()
  hasta?: string;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  conAnticipoDisponible?: boolean;

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
