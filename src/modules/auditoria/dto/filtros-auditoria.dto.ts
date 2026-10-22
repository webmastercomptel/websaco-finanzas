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
    'lote-contabilidad',
    'inmueble',
    'lote-comptable',
  ])
  entidadTipo?:
    | 'entidad-administradora'
    | 'copropiedad'
    | 'usuario'
    | 'lote-facturacion'
    | 'lote-contabilidad'
    | 'inmueble'
    | 'lote-comptable';

  @IsOptional()
  @IsIn([
    'crear',
    'actualizar',
    'revertir',
    'reiniciar',
    'desmarcar',
    'dar-de-baja',
    'retirar',
  ])
  accion?:
    | 'crear'
    | 'actualizar'
    | 'revertir'
    | 'reiniciar'
    | 'desmarcar'
    | 'dar-de-baja'
    | 'retirar';

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
