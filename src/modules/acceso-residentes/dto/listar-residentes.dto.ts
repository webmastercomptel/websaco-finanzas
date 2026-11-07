// src/modules/acceso-residentes/dto/listar-residentes.dto.ts
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

/**
 * Query of `GET /residentes`. No coproperty parameter: the tenant is always the
 * active one, and the global `forbidNonWhitelisted` pipe answers 400 to a client
 * that still sends `coPropertyId`. Unknown values are a 400, never ignored.
 */
export class ListarResidentesDto {
  /** Matches the party's name, any of its emails, or the code of one of its units. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  buscar?: string;

  @IsOptional()
  @IsIn(['todos', 'sinCuenta', 'conCuenta'])
  estadoAcceso?: 'todos' | 'sinCuenta' | 'conCuenta';

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
