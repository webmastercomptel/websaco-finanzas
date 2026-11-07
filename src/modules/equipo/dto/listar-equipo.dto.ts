// src/modules/equipo/dto/listar-equipo.dto.ts
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Query of `GET /equipo`. No coproperty parameter: the tenant is always the
 * active one, and the global `forbidNonWhitelisted` pipe answers 400 to a client
 * that still sends `coPropertyId`.
 */
export class ListarEquipoDto {
  /** Matches name or email. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  buscar?: string;

  /** Defaults to `activo`: a deactivated person is history, not roster. */
  @IsOptional()
  @IsIn(['activo', 'inactivo', 'todos'])
  estado?: 'activo' | 'inactivo' | 'todos';
}
