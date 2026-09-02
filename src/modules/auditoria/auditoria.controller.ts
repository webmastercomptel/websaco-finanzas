// src/modules/auditoria/auditoria.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { AuditoriaService } from './auditoria.service';
import { FiltrosAuditoriaDto } from './dto/filtros-auditoria.dto';
import type { RegistroAuditoriaContract, Paginado } from '../../contracts';

/**
 * Serves the paginated, filterable audit log. Used both by the dashboard's
 * "last 10" card (porPagina=10, no filters) and the full /logs page.
 *
 * `PlatformAdminGuard`: audit data sits above any single coproperty, same
 * as the Entidades/Copropiedades/Usuarios catalogs it records mutations for.
 */
@Controller('auditoria')
@UseGuards(FirebaseAuthGuard, PlatformAdminGuard)
export class AuditoriaController {
  constructor(private readonly auditoria: AuditoriaService) {}

  @Get()
  async findAll(
    @Query() query: FiltrosAuditoriaDto,
  ): Promise<Paginado<RegistroAuditoriaContract>> {
    const { items, total, pagina, porPagina } =
      await this.auditoria.findAll(query);

    return {
      items: items.map((r) => ({
        id: (r as unknown as { _id: { toString(): string } })._id.toString(),
        actorNombre: r.actorNombre,
        accion: r.accion,
        entidadTipo: r.entidadTipo,
        entidadEtiqueta: r.entidadEtiqueta,
        fecha: (r as unknown as { createdAt: Date }).createdAt.toISOString(),
      })),
      total,
      pagina,
      porPagina,
    };
  }
}
