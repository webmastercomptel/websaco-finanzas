// src/modules/acceso-residentes/acceso-residentes.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  AccesoResidenteCreado,
  AprovisionamientoResidentes,
  Paginado,
  ResidenteAcceso,
  ResultadoInvitacion,
} from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { AccesoResidentesService } from './acceso-residentes.service';
import { AprovisionarResidentesDto } from './dto/aprovisionar-residentes.dto';
import { CrearAccesoResidenteDto } from './dto/crear-acceso-residente.dto';
import { ListarResidentesDto } from './dto/listar-residentes.dto';

/**
 * Sign-in access of the coproperty's owners and tenants. It reuses the
 * `Usuario` permissions of Administración (no new catalog key): `usuarios.ver`
 * lists, `usuarios.crear` creates/links and provisions in bulk, `usuarios.editar`
 * re-sends an invitation, `usuarios.eliminar` unlinks.
 *
 * `aprovisionar` is declared before the `:terceroId` routes so the literal
 * segment is never read as an id.
 */
@Controller('residentes')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class AccesoResidentesController {
  constructor(private readonly residentes: AccesoResidentesService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Usuario' })
  listar(
    @Query() filtros: ListarResidentesDto,
  ): Promise<Paginado<ResidenteAcceso>> {
    return this.residentes.listar(filtros);
  }

  @Post('aprovisionar')
  @CheckAbility({ action: 'create', subject: 'Usuario' })
  aprovisionar(
    @Body() dto: AprovisionarResidentesDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<AprovisionamientoResidentes> {
    return this.residentes.aprovisionar(dto, user);
  }

  @Post(':terceroId/acceso')
  @CheckAbility({ action: 'create', subject: 'Usuario' })
  crearAcceso(
    @Param('terceroId') terceroId: string,
    @Body() dto: CrearAccesoResidenteDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<AccesoResidenteCreado> {
    return this.residentes.crearAcceso(terceroId, dto, user);
  }

  @Post(':terceroId/reenviar-invitacion')
  @CheckAbility({ action: 'update', subject: 'Usuario' })
  reenviarInvitacion(
    @Param('terceroId') terceroId: string,
  ): Promise<ResultadoInvitacion> {
    return this.residentes.reenviarInvitacion(terceroId);
  }

  @Delete(':terceroId/acceso')
  @CheckAbility({ action: 'remove', subject: 'Usuario' })
  desvincular(
    @Param('terceroId') terceroId: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<{ id: string }> {
    return this.residentes.desvincular(terceroId, user);
  }
}
