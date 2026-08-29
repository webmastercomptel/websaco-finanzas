// src/modules/usuarios/dto/listar-usuarios.dto.ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Query parameters for the user listing. Same shape as the other catalogs'. */
export class ListarUsuariosDto {
  /** Matches name or email. */
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
