// src/modules/actividades/actividades.controller.ts
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
import type { Actividad } from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ActividadesService } from './actividades.service';
import { ActualizarActividadDto } from './dto/actualizar-actividad.dto';
import { CrearActividadDto } from './dto/guardar-actividad.dto';
import { ListarActividadesDto } from './dto/listar-actividades.dto';

/**
 * Staff side of the community activities: `read` lists, `manage` creates, edits
 * and deletes. Signing up is NOT here: attendance belongs to residents and
 * lives under `ActividadesPortalController` (`/portal/actividades`), which has
 * no CASL permission because residents carry none.
 */
@Controller('actividades')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class ActividadesController {
  constructor(private readonly actividades: ActividadesService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Actividad' })
  listar(@Query() filtros: ListarActividadesDto): Promise<Actividad[]> {
    return this.actividades.listar(filtros);
  }

  @Post()
  @CheckAbility({ action: 'manage', subject: 'Actividad' })
  crear(@Body() dto: CrearActividadDto): Promise<Actividad> {
    return this.actividades.crear(dto);
  }

  @Patch(':id')
  @CheckAbility({ action: 'manage', subject: 'Actividad' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarActividadDto,
  ): Promise<Actividad> {
    return this.actividades.actualizar(id, dto);
  }

  @Delete(':id')
  @CheckAbility({ action: 'manage', subject: 'Actividad' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.actividades.eliminar(id);
  }
}
