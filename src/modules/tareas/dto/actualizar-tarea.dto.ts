// src/modules/tareas/dto/actualizar-tarea.dto.ts
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsISO8601,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
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
 * Body of `PATCH /tareas/:id`: an edit or a kanban drag (`{ estado, orden }`).
 * Every field is optional; only the ones present are written.
 */
export class ActualizarTareaDto {
  @IsString()
  @IsOptional()
  titulo?: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsIn(CATEGORIAS_TAREA)
  @IsOptional()
  categoria?: CategoriaTarea;

  @IsIn(PRIORIDADES_TAREA)
  @IsOptional()
  prioridad?: PrioridadTarea;

  @IsIn(ESTADOS_TAREA)
  @IsOptional()
  estado?: EstadoTarea;

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

  /** `null` clears the deadline; omitting it leaves it untouched. */
  @ValidateIf((_, value) => value !== null)
  @IsISO8601()
  @IsOptional()
  fechaLimite?: string | null;

  @IsNumber()
  @IsOptional()
  orden?: number;
}
