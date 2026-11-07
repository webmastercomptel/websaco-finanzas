// src/modules/tareas/dto/listar-tareas.dto.ts
import { IsIn, IsOptional } from 'class-validator';
import {
  ESTADOS_TAREA,
  type EstadoTarea,
} from '../../../database/schemas/administracion/tarea.schema';

/** Every state the list accepts: the three columns, or `todos` for no filter. */
export const FILTROS_ESTADO_TAREA = ['todos', ...ESTADOS_TAREA] as const;

/**
 * Query of `GET /tareas`. There is deliberately no coproperty parameter: the
 * tenant is always the active one from the request context, and the global
 * `forbidNonWhitelisted` pipe rejects a client that still sends it.
 */
export class ListarTareasDto {
  @IsIn(FILTROS_ESTADO_TAREA)
  @IsOptional()
  estado?: 'todos' | EstadoTarea;
}
