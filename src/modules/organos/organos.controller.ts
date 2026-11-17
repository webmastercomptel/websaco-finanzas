// src/modules/organos/organos.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  CandidatoOrgano,
  IntegranteOrgano,
  OrganosCopropiedad,
} from '../../contracts';
import {
  ORGANOS_COPROPIEDAD,
  type OrganoCopropiedad,
} from '../../database/schemas/administracion/integrante-organo.schema';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { GuardarIntegranteOrganoDto } from './dto/guardar-integrante-organo.dto';
import { ListarCandidatosOrganoDto } from './dto/listar-candidatos-organo.dto';
import { OrganosService } from './organos.service';

/** `ParseEnumPipe` wants an enum object; this one answers 400 to any other body. */
export const PIPE_ORGANO = new ParseEnumPipe(
  Object.fromEntries(ORGANOS_COPROPIEDAD.map((o) => [o, o])),
);

/**
 * Members of the Consejo de Administración and the Comité de Convivencia.
 * Reuses the `Usuario` abilities (no new permission key): whoever manages the
 * building's people manages who sits on these bodies. The static `candidatos`
 * and `integrantes/:id` paths never collide with `:organo/integrantes`.
 */
@Controller('organos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class OrganosController {
  constructor(private readonly organos: OrganosService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Usuario' })
  listar(): Promise<OrganosCopropiedad> {
    return this.organos.listar();
  }

  @Get('candidatos')
  @CheckAbility({ action: 'read', subject: 'Usuario' })
  candidatos(
    @Query() filtros: ListarCandidatosOrganoDto,
  ): Promise<CandidatoOrgano[]> {
    return this.organos.candidatos(filtros.q);
  }

  @Post(':organo/integrantes')
  @CheckAbility({ action: 'update', subject: 'Usuario' })
  agregar(
    @Param('organo', PIPE_ORGANO) organo: OrganoCopropiedad,
    @Body() dto: GuardarIntegranteOrganoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<IntegranteOrgano> {
    return this.organos.agregar(organo, dto.terceroId, user);
  }

  @Delete('integrantes/:id')
  @CheckAbility({ action: 'update', subject: 'Usuario' })
  quitar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<{ id: string }> {
    return this.organos.quitar(id, user);
  }
}
