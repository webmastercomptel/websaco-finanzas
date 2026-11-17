// src/modules/pqr/dto/guardar-tarea-pqr.dto.ts
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  CATEGORIAS_TAREA,
  PRIORIDADES_TAREA,
  type CategoriaTarea,
  type PrioridadTarea,
} from '../../../database/schemas/administracion/tarea.schema';

/**
 * Body of `POST /pqrs/:id/tareas`. A task created from a PQRS needs at least
 * one collaborator (that is the point of delegating it); the tenant and the
 * link to the PQRS never come from the body.
 */
export class CrearTareaPqrDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  titulo: string;

  @IsString()
  @MaxLength(5000)
  @IsOptional()
  descripcion?: string;

  /** Defaults to `admin` in the service. */
  @IsIn(CATEGORIAS_TAREA)
  @IsOptional()
  categoria?: CategoriaTarea;

  @IsIn(PRIORIDADES_TAREA)
  @IsOptional()
  prioridad?: PrioridadTarea;

  /** Duplicates are rejected: the notices assume a set. */
  @IsArray({ message: 'Elige al menos un colaborador.' })
  @ArrayMinSize(1, { message: 'Elige al menos un colaborador.' })
  @IsMongoId({ each: true, message: 'Colaborador no válido.' })
  @ArrayUnique({ message: 'Hay colaboradores repetidos.' })
  asignadosIds: string[];

  @IsISO8601()
  @IsOptional()
  fechaLimite?: string;
}
