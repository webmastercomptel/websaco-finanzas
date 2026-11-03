// src/modules/integraciones-panel/integraciones-panel.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { RegistroPanel } from '../../contracts';
import {
  ActualizarVinculoDto,
  RegistroPanelParamDto,
} from './dto/actualizar-vinculo.dto';
import { ListarRegistrosDto } from './dto/listar-registros.dto';
import { FirmaPanelGuard } from './firma-panel.guard';
import { IntegracionesPanelService } from './integraciones-panel.service';
import { PanelHabilitadoGuard } from './panel-habilitado.guard';

/**
 * Edge of the integrations panel. The ONLY guards are the panel's signature
 * and the module switch, in that order: the caller is a machine with no user
 * and no tenant, so there is no Firebase and no CASL here.
 */
@Controller('integraciones/panel')
@UseGuards(FirmaPanelGuard, PanelHabilitadoGuard)
export class IntegracionesPanelController {
  constructor(private readonly servicio: IntegracionesPanelService) {}

  @Get('registros')
  listar(
    @Query() query: ListarRegistrosDto,
  ): Promise<{ items: RegistroPanel[]; total: number }> {
    return this.servicio.listar(query);
  }

  @Put('registros/:id/vinculo')
  fijarVinculo(
    @Param() params: RegistroPanelParamDto,
    @Body() dto: ActualizarVinculoDto,
  ): Promise<{ sistema: string; registroId: string | null }> {
    return this.servicio.fijarVinculo(params.id, dto);
  }
}
