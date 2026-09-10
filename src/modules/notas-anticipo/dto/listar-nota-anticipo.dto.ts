import { Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';

export class ListarNotaAnticipoDto {
  @IsOptional()
  @IsMongoId()
  reciboOrigenId?: string;

  @IsOptional()
  @IsMongoId()
  inmuebleId?: string;

  @IsOptional()
  @IsIn(['activo', 'anulado'])
  estado?: 'activo' | 'anulado';

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
