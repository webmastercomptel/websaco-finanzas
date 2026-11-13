// src/modules/equipo/equipo.controller.ts
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
import type {
  MiembroEquipo,
  MiembroEquipoCreado,
  ResultadoInvitacion,
} from '../../contracts';
import { CheckAbility, ModuloAlguno } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import {
  ActualizarMiembroEquipoDto,
  CrearMiembroEquipoDto,
} from './dto/guardar-miembro.dto';
import { ListarEquipoDto } from './dto/listar-equipo.dto';
import { EquipoService } from './equipo.service';

/**
 * Team of the active coproperty. It reuses the `Usuario` permissions of
 * Administración (no new catalog key): `usuarios.ver` lists, `crear` adds,
 * `editar` edits/re-invites, `eliminar` deactivates. What a caller may grant or
 * take away, of ANY offered module, is further capped by their own permissions
 * in the service (the delegation law); this layer only decides who may use the
 * door at all.
 *
 * Licence: `@ModuloAlguno('finanzas', 'administracion')`. A team is managed
 * whichever product the building bought, so either module opens the door; the
 * `usuarios.*` keys are still required, and a key of a module the coproperty did
 * not contract is stored but inert. `/residentes` stays Administración only.
 */
@Controller('equipo')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@ModuloAlguno('finanzas', 'administracion')
export class EquipoController {
  constructor(private readonly equipo: EquipoService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Usuario' })
  listar(@Query() filtros: ListarEquipoDto): Promise<MiembroEquipo[]> {
    return this.equipo.listar(filtros);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Usuario' })
  obtener(@Param('id') id: string): Promise<MiembroEquipo> {
    return this.equipo.obtener(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Usuario' })
  crear(
    @Body() dto: CrearMiembroEquipoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<MiembroEquipoCreado> {
    return this.equipo.crear(dto, user);
  }

  @Patch(':id')
  @CheckAbility({ action: 'update', subject: 'Usuario' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarMiembroEquipoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<MiembroEquipo> {
    return this.equipo.actualizar(id, dto, user);
  }

  @Post(':id/reenviar-invitacion')
  @CheckAbility({ action: 'update', subject: 'Usuario' })
  reenviarInvitacion(@Param('id') id: string): Promise<ResultadoInvitacion> {
    return this.equipo.reenviarInvitacion(id);
  }

  /** Deactivates the member's access to THIS coproperty; nothing is deleted. */
  @Delete(':id')
  @CheckAbility({ action: 'remove', subject: 'Usuario' })
  desactivar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<{ id: string }> {
    return this.equipo.desactivar(id, user);
  }
}
