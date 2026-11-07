// src/modules/documentos/documentos.controller.ts
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
  ArchivoAdministracion,
  CarpetaAdministracion,
  DescargaArchivo,
  EstadisticasArchivos,
  RutaCarpetaAdministracion,
  SubidaArchivoIniciada,
} from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { CarpetasService } from './carpetas.service';
import { DocumentosService } from './documentos.service';
import { ActualizarCarpetaDto } from './dto/actualizar-carpeta.dto';
import { ActualizarDocumentoDto } from './dto/actualizar-documento.dto';
import { CrearCarpetaDto } from './dto/guardar-carpeta.dto';
import { CrearDocumentoDto } from './dto/guardar-documento.dto';
import {
  ListarCarpetasDto,
  ListarDocumentosDto,
} from './dto/listar-documentos.dto';

/**
 * Staff side of the document library. The ability on each route is only the
 * door; WHICH folders a caller reaches is decided per request by the folder
 * rules (see `DocumentosService`), and `gestionar` bypasses them:
 *
 * - `read Documento` (`documentos-administracion.ver`): lists and downloads.
 * - `create Documento` (`.subir`): starts/confirms an upload and edits a file.
 * - `manage Documento` (`.gestionar`): creates, edits and deletes folders and
 *   their rules, and deletes files. There is no `eliminar` key for documents.
 *
 * Residents do not come through here: they have no permissions and read through
 * `DocumentosPortalController` (`/portal/documentos`).
 *
 * Static `carpetas/...` and `stats` routes are declared before the `:id` ones.
 */
@Controller('documentos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class DocumentosController {
  constructor(
    private readonly documentos: DocumentosService,
    private readonly carpetas: CarpetasService,
  ) {}

  // ── Folders ──────────────────────────────────────────────────────────

  @Get('carpetas')
  @CheckAbility({ action: 'read', subject: 'Documento' })
  listarCarpetas(
    @Query() filtros: ListarCarpetasDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<CarpetaAdministracion[]> {
    return this.carpetas.listar(filtros, user);
  }

  @Get('carpetas/por-slug/:slug')
  @CheckAbility({ action: 'read', subject: 'Documento' })
  carpetaPorSlug(
    @Param('slug') slug: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<CarpetaAdministracion> {
    return this.carpetas.porSlug(slug, user);
  }

  @Get('carpetas/:id/ruta')
  @CheckAbility({ action: 'read', subject: 'Documento' })
  rutaDeCarpeta(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<RutaCarpetaAdministracion[]> {
    return this.carpetas.ruta(id, user);
  }

  @Post('carpetas')
  @CheckAbility({ action: 'manage', subject: 'Documento' })
  crearCarpeta(
    @Body() dto: CrearCarpetaDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<CarpetaAdministracion> {
    return this.carpetas.crear(dto, user);
  }

  @Patch('carpetas/:id')
  @CheckAbility({ action: 'manage', subject: 'Documento' })
  actualizarCarpeta(
    @Param('id') id: string,
    @Body() dto: ActualizarCarpetaDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<CarpetaAdministracion> {
    return this.carpetas.actualizar(id, dto, user);
  }

  @Delete('carpetas/:id')
  @CheckAbility({ action: 'manage', subject: 'Documento' })
  eliminarCarpeta(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<{ id: string }> {
    return this.carpetas.eliminar(id, user);
  }

  // ── Files ────────────────────────────────────────────────────────────

  @Get('stats')
  @CheckAbility({ action: 'read', subject: 'Documento' })
  estadisticas(): Promise<EstadisticasArchivos> {
    return this.documentos.estadisticas();
  }

  @Get()
  @CheckAbility({ action: 'read', subject: 'Documento' })
  listar(
    @Query() filtros: ListarDocumentosDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<ArchivoAdministracion[]> {
    return this.documentos.listar(filtros, user);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Documento' })
  iniciarSubida(
    @Body() dto: CrearDocumentoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<SubidaArchivoIniciada> {
    return this.documentos.iniciar(dto, user);
  }

  @Patch(':id/confirmar')
  @CheckAbility({ action: 'create', subject: 'Documento' })
  confirmarSubida(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<ArchivoAdministracion> {
    return this.documentos.confirmar(id, user);
  }

  @Get(':id/descarga')
  @CheckAbility({ action: 'read', subject: 'Documento' })
  descargar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<DescargaArchivo> {
    return this.documentos.descargar(id, user);
  }

  @Patch(':id')
  @CheckAbility({ action: 'create', subject: 'Documento' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarDocumentoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<ArchivoAdministracion> {
    return this.documentos.actualizar(id, dto, user);
  }

  @Delete(':id')
  @CheckAbility({ action: 'manage', subject: 'Documento' })
  eliminar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<{ id: string }> {
    return this.documentos.eliminar(id, user);
  }
}
