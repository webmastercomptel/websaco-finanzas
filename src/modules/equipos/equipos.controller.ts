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
import type { Equipo, HojaDeVidaEquipo } from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ActualizarEquipoDto } from './dto/actualizar-equipo.dto';
import { CrearEquipoDto } from './dto/guardar-equipo.dto';
import { ListarEquiposDto } from './dto/listar-equipos.dto';
import { EquiposService } from './equipos.service';

/**
 * Equipment catalog of the active coproperty. It reuses the maintenance
 * subject on purpose (no `equipos.*` key): whoever sees maintenance reads the
 * catalog, whoever manages it writes it.
 */
@Controller('equipos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class EquiposController {
  constructor(private readonly equipos: EquiposService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Mantenimiento' })
  listar(@Query() filtros: ListarEquiposDto): Promise<Equipo[]> {
    return this.equipos.listar(filtros);
  }

  /**
   * Literal two-segment path: it can never be swallowed by the single-segment
   * `PATCH/DELETE :id` routes (different verb and segment count).
   */
  @Get(':id/hoja-de-vida')
  @CheckAbility({ action: 'read', subject: 'Mantenimiento' })
  hojaDeVida(@Param('id') id: string): Promise<HojaDeVidaEquipo> {
    return this.equipos.hojaDeVida(id);
  }

  @Post()
  @CheckAbility({ action: 'manage', subject: 'Mantenimiento' })
  crear(@Body() dto: CrearEquipoDto): Promise<Equipo> {
    return this.equipos.crear(dto);
  }

  @Patch(':id')
  @CheckAbility({ action: 'manage', subject: 'Mantenimiento' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarEquipoDto,
  ): Promise<Equipo> {
    return this.equipos.actualizar(id, dto);
  }

  @Delete(':id')
  @CheckAbility({ action: 'manage', subject: 'Mantenimiento' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.equipos.eliminar(id);
  }
}
