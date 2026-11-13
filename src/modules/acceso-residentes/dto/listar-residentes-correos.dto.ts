// src/modules/acceso-residentes/dto/listar-residentes-correos.dto.ts
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** The values `estado` may take: a row state, or `todos` for no filter. */
export const ESTADOS_FILTRO_RESIDENTES = [
  'todos',
  'sin-ingreso',
  'ingreso',
  'revocado',
  'heredado',
] as const;

/**
 * Query of `GET /residentes/correos`. No coproperty parameter: the tenant is
 * always the active one, and the global `forbidNonWhitelisted` pipe answers 400
 * to a client that sends `coPropertyId`. Unknown values are a 400, never ignored.
 */
export class ListarResidentesCorreosDto {
  /** Matches the party's name, one of its addresses, or the code of one of its units. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  buscar?: string;

  @IsOptional()
  @IsIn(ESTADOS_FILTRO_RESIDENTES)
  estado?: (typeof ESTADOS_FILTRO_RESIDENTES)[number];

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
