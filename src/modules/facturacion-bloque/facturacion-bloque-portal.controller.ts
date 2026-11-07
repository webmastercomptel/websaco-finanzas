// src/modules/facturacion-bloque/facturacion-bloque-portal.controller.ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { DescargaArchivo, MiDocumentoBloque } from '../../contracts';
import { Modulo } from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { ListarMisDocumentosDto } from './dto/listar-bloques.dto';
import { FacturacionBloquePortalService } from './facturacion-bloque-portal.service';

/**
 * Resident side of the block billing: list the documents of the units the caller
 * holds and download one through a short-lived signed URL. Guarded by
 * `PortalGuard` (the caller must hold a unit of the ACTIVE coproperty, which must
 * have contracted the module) and deliberately NOT by CASL: residents carry no
 * permissions, and `PoliciesGuard` would lock out exactly the people this is for.
 *
 * Authorization is data-level and per unit (owner: invoices and statements of
 * account; tenant: invoices; receipts: never). There is no write route here and
 * must not be one.
 */
@Controller('portal/mis-documentos')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('administracion')
export class FacturacionBloquePortalController {
  constructor(private readonly documentos: FacturacionBloquePortalService) {}

  @Get()
  listar(
    @Query() filtros: ListarMisDocumentosDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<MiDocumentoBloque[]> {
    return this.documentos.listar(filtros, user);
  }

  @Get(':id/descarga')
  descargar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<DescargaArchivo> {
    return this.documentos.descargar(id, user);
  }
}
