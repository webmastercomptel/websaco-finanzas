import { IsOptional, IsIn, IsDateString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** DTO for GET /auditoria — filtered, paginated audit log listing. */
export class FiltrosAuditoriaDto {
  @IsOptional()
  @IsIn([
    'entidad-administradora',
    'copropiedad',
    'usuario',
    'lote-facturacion',
  ])
  entidadTipo?:
    'entidad-administradora' | 'copropiedad' | 'usuario' | 'lote-facturacion';

  @IsOptional()
  @IsIn(['crear', 'actualizar', 'revertir'])
  accion?: 'crear' | 'actualizar' | 'revertir';

  @IsOptional()
  @IsDateString()
  desde?: string;

  @IsOptional()
  @IsDateString()
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  porPagina?: number;
}
