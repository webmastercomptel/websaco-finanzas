// src/modules/anuncios/anuncios-portal.controller.ts
import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { Anuncio } from '../../contracts';
import { Modulo } from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { AnunciosService } from './anuncios.service';
import { ListarAnunciosPortalDto } from './dto/listar-anuncios.dto';

/**
 * Resident side of the announcements: list the PUBLISHED ones, like them, and
 * count an open. Guarded by `PortalGuard` (the caller must hold a unit of the
 * ACTIVE coproperty, which must have contracted the module) and deliberately
 * NOT by CASL: residents carry no permissions, and putting these routes behind
 * `PoliciesGuard` would lock out exactly the people they are for. A resident
 * can write nothing here but their own like and a view; a draft is a 404.
 */
@Controller('portal/anuncios')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('administracion')
export class AnunciosPortalController {
  constructor(private readonly anuncios: AnunciosService) {}

  @Get()
  listar(
    @Query() filtros: ListarAnunciosPortalDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Anuncio[]> {
    return this.anuncios.listarParaResidente(filtros, user);
  }

  @Post(':id/vista')
  vista(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<Anuncio> {
    return this.anuncios.registrarVista(id, user);
  }

  @Post(':id/like')
  like(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<Anuncio> {
    return this.anuncios.alternarMeGusta(id, user);
  }
}
