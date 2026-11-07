// src/modules/mantenimientos/mantenimientos.controller.ts
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
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { Mantenimiento, MantenimientosStats } from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ActualizarMantenimientoDto } from './dto/actualizar-mantenimiento.dto';
import { CrearMantenimientoDto } from './dto/guardar-mantenimiento.dto';
import { ListarMantenimientosDto } from './dto/listar-mantenimientos.dto';
import { MantenimientosService } from './mantenimientos.service';

/**
 * Maintenance jobs of the active coproperty. The abilities are a security
 * decision, not a convenience: reading (list and counters) needs `read`, and
 * anything that creates, edits or deletes needs `manage`. Do not "simplify" a
 * write route down to `update`.
 *
 * `estadisticas` is declared before every `:id` route so the param route never
 * swallows `stats`.
 */
@Controller('mantenimientos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class MantenimientosController {
  constructor(private readonly mantenimientos: MantenimientosService) {}

  @Get('stats')
  @CheckAbility({ action: 'read', subject: 'Mantenimiento' })
  estadisticas(): Promise<MantenimientosStats> {
    return this.mantenimientos.estadisticas();
  }

  @Get()
  @CheckAbility({ action: 'read', subject: 'Mantenimiento' })
  listar(@Query() filtros: ListarMantenimientosDto): Promise<Mantenimiento[]> {
    return this.mantenimientos.listar(filtros);
  }

  @Post()
  @CheckAbility({ action: 'manage', subject: 'Mantenimiento' })
  crear(@Body() dto: CrearMantenimientoDto): Promise<Mantenimiento> {
    return this.mantenimientos.crear(dto);
  }

  @Patch(':id')
  @CheckAbility({ action: 'manage', subject: 'Mantenimiento' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarMantenimientoDto,
  ): Promise<Mantenimiento> {
    return this.mantenimientos.actualizar(id, dto);
  }

  @Delete(':id')
  @CheckAbility({ action: 'manage', subject: 'Mantenimiento' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.mantenimientos.eliminar(id);
  }
}
