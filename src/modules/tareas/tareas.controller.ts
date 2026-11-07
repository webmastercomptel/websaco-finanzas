// src/modules/tareas/tareas.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { Tarea, TareaAsignable } from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ActualizarTareaDto } from './dto/actualizar-tarea.dto';
import { CrearObservacionDto } from './dto/guardar-observacion.dto';
import { CrearTareaDto } from './dto/guardar-tarea.dto';
import { ListarTareasDto } from './dto/listar-tareas.dto';
import { TareasService } from './tareas.service';

/**
 * Tasks of the active coproperty. The abilities are a security decision, not a
 * convenience: `tareas.gestionar` maps to `manage` and is the only key that may
 * create, edit or delete any task, while `tareas.actualizar` maps to `update`
 * and reaches only `completar` / `observaciones` (which the service narrows
 * further to tasks assigned to the caller). Do not "simplify" an edit or delete
 * route down to `update`.
 */
@Controller('tareas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class TareasController {
  constructor(private readonly tareas: TareasService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Tarea' })
  listar(
    @Query() filtros: ListarTareasDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Tarea[]> {
    return this.tareas.listar(filtros, user);
  }

  /**
   * Staff the task form may offer as assignees. `manage` Tarea, the key that
   * creates and edits tasks: nobody else has a form to fill. Declared before
   * any `:id` route so the literal segment is never read as an id. The list is
   * the same rule the service enforces when it writes the assignment.
   */
  @Get('asignables')
  @CheckAbility({ action: 'manage', subject: 'Tarea' })
  asignables(): Promise<TareaAsignable[]> {
    return this.tareas.asignables();
  }

  @Post()
  @CheckAbility({ action: 'manage', subject: 'Tarea' })
  crear(
    @Body() dto: CrearTareaDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Tarea> {
    return this.tareas.crear(dto, user);
  }

  @Patch(':id')
  @CheckAbility({ action: 'manage', subject: 'Tarea' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarTareaDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Tarea> {
    return this.tareas.actualizar(id, dto, user);
  }

  @Delete(':id')
  @CheckAbility({ action: 'manage', subject: 'Tarea' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.tareas.eliminar(id);
  }

  @Patch(':id/completar')
  @CheckAbility({ action: 'update', subject: 'Tarea' })
  completar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<Tarea> {
    return this.tareas.completar(id, user);
  }

  @Post(':id/observaciones')
  @CheckAbility({ action: 'update', subject: 'Tarea' })
  agregarObservacion(
    @Param('id') id: string,
    @Body() dto: CrearObservacionDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Tarea> {
    return this.tareas.agregarObservacion(id, dto.texto, user);
  }
}
