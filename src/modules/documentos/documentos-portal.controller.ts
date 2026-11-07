// src/modules/documentos/documentos-portal.controller.ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  ArchivoAdministracion,
  CarpetaAdministracionPortal,
  DescargaArchivo,
  RutaCarpetaAdministracion,
} from '../../contracts';
import { Modulo } from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { DocumentosPortalService } from './documentos-portal.service';
import {
  ListarCarpetasDto,
  ListarDocumentosDto,
} from './dto/listar-documentos.dto';

/**
 * Resident side of the document library: READ-ONLY. Guarded by `PortalGuard`
 * (the caller must hold a unit of the ACTIVE coproperty, which must have
 * contracted the module) and deliberately NOT by CASL: residents carry no
 * permissions, and `PoliciesGuard` would lock out exactly the people this is for.
 *
 * Authorization is data-level: only folders whose rules include a `residentes`
 * rule matching how the caller holds their units are visible; anything else is a
 * 404. There is no upload, edit or delete route here and must not be one.
 */
@Controller('portal/documentos')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('administracion')
export class DocumentosPortalController {
  constructor(private readonly documentos: DocumentosPortalService) {}

  @Get('carpetas')
  listarCarpetas(
    @Query() filtros: ListarCarpetasDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<CarpetaAdministracionPortal[]> {
    return this.documentos.listarCarpetas(filtros, user);
  }

  @Get('carpetas/por-slug/:slug')
  carpetaPorSlug(
    @Param('slug') slug: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<CarpetaAdministracionPortal> {
    return this.documentos.carpetaPorSlug(slug, user);
  }

  @Get('carpetas/:id/ruta')
  rutaDeCarpeta(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<RutaCarpetaAdministracion[]> {
    return this.documentos.ruta(id, user);
  }

  @Get()
  listar(
    @Query() filtros: ListarDocumentosDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<ArchivoAdministracion[]> {
    return this.documentos.listarDocumentos(filtros, user);
  }

  @Get(':id/descarga')
  descargar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<DescargaArchivo> {
    return this.documentos.descargar(id, user);
  }
}
