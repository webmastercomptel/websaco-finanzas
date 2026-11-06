// src/modules/portal/dto/portal.dto.ts
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/** Query for `GET /portal/facturas`: always one unit, chosen from the caller's own list. */
export class ListarFacturasPortalDto {
  @IsMongoId()
  inmuebleId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  porPagina?: number;
}

/** Query for `GET /portal/estado-cuenta` (owners only). */
export class EstadoCuentaPortalDto {
  @IsMongoId()
  inmuebleId!: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;
}
