// src/modules/actividades/actividades-portal.controller.ts
import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { Actividad } from '../../contracts';
import { Modulo } from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import {
  ActividadesService,
  type ResultadoAsistencia,
} from './actividades.service';
import { ListarActividadesDto } from './dto/listar-actividades.dto';

/**
 * Resident side of the community activities: list them (with whether the
 * caller is signed up) and toggle attendance. Guarded by `PortalGuard` (the
 * caller must hold a unit of the ACTIVE coproperty, which must have contracted
 * the module) and deliberately NOT by CASL: residents carry no permissions, and
 * putting these routes behind `PoliciesGuard` would lock out exactly the people
 * they are for.
 */
@Controller('portal/actividades')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('administracion')
export class ActividadesPortalController {
  constructor(private readonly actividades: ActividadesService) {}

  @Get()
  listar(
    @Query() filtros: ListarActividadesDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Actividad[]> {
    return this.actividades.listarParaResidente(filtros, user);
  }

  @Post(':id/asistir')
  asistir(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoAsistencia> {
    return this.actividades.alternarAsistencia(id, user);
  }
}
