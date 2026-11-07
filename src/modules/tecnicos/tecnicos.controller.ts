import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { Tecnico } from '../../contracts';
import {
  CheckAbility,
  CheckAnyAbility,
  Modulo,
} from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ActualizarTecnicoDto } from './dto/actualizar-tecnico.dto';
import { CrearTecnicoDto } from './dto/guardar-tecnico.dto';
import { TecnicosService } from './tecnicos.service';

/**
 * Technicians of the active coproperty. Writes need `manage` Tecnico
 * (`tecnicos.gestionar`). The list is open to whoever works PQRs too, because
 * the assign-technician dialog needs it: there is no `tecnicos.ver` permission,
 * so it accepts `read` Pqr OR `manage` Tecnico (at least one, never neither).
 * The system this was ported from left the list open to any signed-in user.
 */
@Controller('tecnicos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class TecnicosController {
  constructor(private readonly tecnicos: TecnicosService) {}

  @Get()
  @CheckAnyAbility(
    { action: 'read', subject: 'Pqr' },
    { action: 'manage', subject: 'Tecnico' },
  )
  listar(): Promise<Tecnico[]> {
    return this.tecnicos.listar();
  }

  @Post()
  @CheckAbility({ action: 'manage', subject: 'Tecnico' })
  crear(@Body() dto: CrearTecnicoDto): Promise<Tecnico> {
    return this.tecnicos.crear(dto);
  }

  @Patch(':id')
  @CheckAbility({ action: 'manage', subject: 'Tecnico' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarTecnicoDto,
  ): Promise<Tecnico> {
    return this.tecnicos.actualizar(id, dto);
  }

  @Delete(':id')
  @CheckAbility({ action: 'manage', subject: 'Tecnico' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.tecnicos.eliminar(id);
  }
}
