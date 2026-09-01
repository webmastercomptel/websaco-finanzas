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

const aBooleano = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
};

export class ListarNotaDebitoDto {
  @IsOptional()
  @IsMongoId()
  inmuebleId?: string;

  @IsOptional()
  @IsIn(['emitida', 'anulada'])
  estado?: 'emitida' | 'anulada';

  @IsOptional()
  @IsDateString()
  fechaDesde?: string;

  @IsOptional()
  @IsDateString()
  fechaHasta?: string;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  conSaldoPendiente?: boolean;

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
