// src/modules/configuracion/cuentas-contables/dto/listar-cuentas.dto.ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Query parameters for the chart-of-accounts listing. */
export class ListarCuentasDto {
  /** Matches code or name. */
  @IsOptional()
  @IsString()
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
