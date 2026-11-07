// src/modules/anuncios/anuncios.controller.ts
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
import type { Anuncio } from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { AnunciosEntregaService } from './anuncios-entrega.service';
import { AnunciosService } from './anuncios.service';
import { ActualizarAnuncioDto } from './dto/actualizar-anuncio.dto';
import { CrearAnuncioDto } from './dto/guardar-anuncio.dto';
import { ListarAnunciosDto } from './dto/listar-anuncios.dto';
import { PublicarAnuncioDto } from './dto/publicar-anuncio.dto';

/**
 * Staff side of the announcements: `anuncios.ver` lists, `crear` writes a
 * draft, `editar` edits AND publishes (publishing is what the system this
 * replaces already gated with `update`), `eliminar` deletes. Residents never
 * come through here: they read published announcements under
 * `AnunciosPortalController` (`/portal/anuncios`).
 */
@Controller('anuncios')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class AnunciosController {
  constructor(
    private readonly anuncios: AnunciosService,
    private readonly entrega: AnunciosEntregaService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Anuncio' })
  listar(@Query() filtros: ListarAnunciosDto): Promise<Anuncio[]> {
    return this.anuncios.listar(filtros);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Anuncio' })
  crear(
    @Body() dto: CrearAnuncioDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Anuncio> {
    return this.anuncios.crear(dto, user);
  }

  @Patch(':id')
  @CheckAbility({ action: 'update', subject: 'Anuncio' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarAnuncioDto,
  ): Promise<Anuncio> {
    return this.anuncios.actualizar(id, dto);
  }

  @Delete(':id')
  @CheckAbility({ action: 'remove', subject: 'Anuncio' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.anuncios.eliminar(id);
  }

  /**
   * Publishes the announcement and delivers it to the residents inside this
   * request. Calling it again resumes a delivery that failed or was cut short;
   * it never re-sends to somebody already delivered. The body is validated only
   * so an unsupported channel is a 400 (see `PublicarAnuncioDto`).
   */
  @Post(':id/publicar')
  @CheckAbility({ action: 'update', subject: 'Anuncio' })
  publicar(
    @Param('id') id: string,
    @Body() _dto: PublicarAnuncioDto,
  ): Promise<Anuncio> {
    return this.entrega.publicar(id);
  }
}
