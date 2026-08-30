import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';

const aBooleano = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
};

export class ListarFacturasDto {
  @IsOptional()
  @IsMongoId()
  inmuebleId?: string;

  // What a Recibo can be applied against (design §5, "Cartera pendiente" —
  // no new endpoint, this filter on the existing listing instead).
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
