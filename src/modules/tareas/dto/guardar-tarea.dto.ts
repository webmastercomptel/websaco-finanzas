// src/modules/tareas/dto/guardar-tarea.dto.ts
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  CATEGORIAS_TAREA,
  ESTADOS_TAREA,
  PRIORIDADES_TAREA,
  type CategoriaTarea,
  type EstadoTarea,
  type PrioridadTarea,
} from '../../../database/schemas/administracion/tarea.schema';

/**
 * Body of `POST /tareas`. The tenant is never part of it: it comes from the
 * request context.
 */
export class CrearTareaDto {
  @IsString()
  @IsNotEmpty()
  titulo: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsIn(CATEGORIAS_TAREA)
  categoria: CategoriaTarea;

  @IsIn(PRIORIDADES_TAREA)
  @IsOptional()
  prioridad?: PrioridadTarea;

  @IsIn(ESTADOS_TAREA)
  @IsOptional()
  estado?: EstadoTarea;

  /** Duplicates are rejected: the assignee diff and the notices assume a set. */
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayUnique()
  @IsOptional()
  asignadosIds?: string[];

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  progreso?: number;

  @IsISO8601()
  @IsOptional()
  fechaLimite?: string;

  @IsNumber()
  @IsOptional()
  orden?: number;
}
