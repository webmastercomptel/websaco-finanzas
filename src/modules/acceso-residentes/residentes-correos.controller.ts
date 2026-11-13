// src/modules/acceso-residentes/residentes-correos.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  Paginado,
  ResidenteCorreo,
  ResultadoAccionResidenteCorreo,
  ResultadoReenvioEnlace,
} from '../../contracts';
import { CheckAbility, ModuloAlguno } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { AccionResidenteCorreoDto } from './dto/accion-residente-correo.dto';
import { ListarResidentesCorreosDto } from './dto/listar-residentes-correos.dto';
import { ResidentesCorreosService } from './residentes-correos.service';

/**
 * The Residentes screen after self-service sign-in: one row per (party,
 * address) of the active coproperty, and the three things staff still do by
 * hand — resend the sign-in link, revoke the portal of one address, and allow
 * it again. Nobody grants access here any more: an owner or tenant with an
 * address on the record enters by themselves.
 *
 * Shared by both products on purpose (`@ModuloAlguno`): owners and tenants
 * receive invoices whichever product the building bought, so their portal
 * access must be manageable in a Finanzas-only building too. It reuses the
 * Administración `Usuario` keys: `usuarios.ver` lists, `usuarios.editar`
 * resends and re-allows, `usuarios.eliminar` revokes.
 *
 * A static path of its own (`residentes/correos`), so the old
 * `residentes/:terceroId/...` routes can never read `correos` as an id.
 */
@Controller('residentes/correos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@ModuloAlguno('finanzas', 'administracion')
export class ResidentesCorreosController {
  constructor(private readonly residentes: ResidentesCorreosService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Usuario' })
  listar(
    @Query() filtros: ListarResidentesCorreosDto,
  ): Promise<Paginado<ResidenteCorreo>> {
    return this.residentes.listar(filtros);
  }

  @Post('reenviar')
  @HttpCode(200)
  @CheckAbility({ action: 'update', subject: 'Usuario' })
  reenviar(
    @Body() dto: AccionResidenteCorreoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoReenvioEnlace> {
    return this.residentes.reenviar(dto, user);
  }

  @Post('revocar')
  @HttpCode(200)
  @CheckAbility({ action: 'remove', subject: 'Usuario' })
  revocar(
    @Body() dto: AccionResidenteCorreoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoAccionResidenteCorreo> {
    return this.residentes.revocar(dto, user);
  }

  @Post('permitir')
  @HttpCode(200)
  @CheckAbility({ action: 'update', subject: 'Usuario' })
  permitir(
    @Body() dto: AccionResidenteCorreoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoAccionResidenteCorreo> {
    return this.residentes.permitir(dto, user);
  }
}
