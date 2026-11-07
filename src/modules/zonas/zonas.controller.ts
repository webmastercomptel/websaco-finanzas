// src/modules/zonas/zonas.controller.ts
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
import type { ImagenZonaSubidaIniciada, ZonaComun } from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ActualizarZonaDto } from './dto/actualizar-zona.dto';
import { ConfirmarImagenZonaDto } from './dto/confirmar-imagen-zona.dto';
import { CrearZonaDto } from './dto/guardar-zona.dto';
import { IniciarSubidaImagenZonaDto } from './dto/iniciar-subida-imagen-zona.dto';
import { ListarZonasDto } from './dto/listar-zonas.dto';
import { ZonasImagenService } from './zonas-imagen.service';
import { ZonasService } from './zonas.service';

/**
 * Staff side of the common areas: `read` (`zonas.ver`) lists them; everything
 * that changes one (create, edit, delete, cover image) needs `manage`
 * (`zonas.gestionar`). The system this replaces left the list open to any
 * signed-in user; residents now list what they may book through
 * `ZonasPortalController` (`/portal/espacios`), which carries no permission.
 * Do not "simplify" a write route down to `read`.
 */
@Controller('zonas-comunes')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class ZonasController {
  constructor(
    private readonly zonas: ZonasService,
    private readonly imagenes: ZonasImagenService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Zona' })
  listar(@Query() filtros: ListarZonasDto): Promise<ZonaComun[]> {
    return this.zonas.listar(filtros);
  }

  @Post()
  @CheckAbility({ action: 'manage', subject: 'Zona' })
  crear(@Body() dto: CrearZonaDto): Promise<ZonaComun> {
    return this.zonas.crear(dto);
  }

  @Patch(':id')
  @CheckAbility({ action: 'manage', subject: 'Zona' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarZonaDto,
  ): Promise<ZonaComun> {
    return this.zonas.actualizar(id, dto);
  }

  @Delete(':id')
  @CheckAbility({ action: 'manage', subject: 'Zona' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.zonas.eliminar(id);
  }

  @Post(':id/imagen')
  @CheckAbility({ action: 'manage', subject: 'Zona' })
  iniciarSubidaImagen(
    @Param('id') id: string,
    @Body() dto: IniciarSubidaImagenZonaDto,
  ): Promise<ImagenZonaSubidaIniciada> {
    return this.imagenes.iniciar(id, dto);
  }

  @Patch(':id/imagen/confirmar')
  @CheckAbility({ action: 'manage', subject: 'Zona' })
  confirmarImagen(
    @Param('id') id: string,
    @Body() dto: ConfirmarImagenZonaDto,
  ): Promise<ZonaComun> {
    return this.imagenes.confirmar(id, dto.storagePath);
  }
}
