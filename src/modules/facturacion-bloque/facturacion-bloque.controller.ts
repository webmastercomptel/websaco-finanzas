// src/modules/facturacion-bloque/facturacion-bloque.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  BloqueFacturacion,
  BloqueFacturacionDetalle,
  DescargaArchivo,
  ReporteIngestaBloque,
  SubidaBloqueIniciada,
} from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { CrearBloqueDto } from './dto/guardar-bloque.dto';
import { ListarBloquesDto } from './dto/listar-bloques.dto';
import { FacturacionBloqueEntregaService } from './facturacion-bloque-entrega.service';
import { FacturacionBloqueIngestaService } from './facturacion-bloque-ingesta.service';
import { FacturacionBloqueService } from './facturacion-bloque.service';

/**
 * Staff side of the block billing (externally produced PDFs, one file for every
 * unit). TRANSITIONAL: this module is meant to be deleted whole when the native
 * invoice pipeline replaces it, so nothing outside imports it.
 *
 * The previous system gated these routes with `create`/`delete` on `Documento`;
 * Finanzas has no billing permission and the catalog gets no new keys, so the
 * closest existing semantics are kept, with the same reasoning as before:
 *
 * - `create Documento` (`documentos-administracion.subir`) for list, detail,
 *   upload, ingest and the original. NOT `read`: the default resident-facing
 *   roles hold `.ver`, and these routes expose every unit's data.
 * - `manage Documento` (`documentos-administracion.gestionar`) for the SEND and
 *   the delete: sending is irreversible and reaches every resident, so it is not
 *   something the person who merely uploads should be able to trigger. (The
 *   previous system let any uploader send; confirm with the product owner.)
 *
 * Residents never come through here: they read under
 * `FacturacionBloquePortalController` (`/portal/mis-documentos`).
 */
@Controller('facturacion-bloque')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class FacturacionBloqueController {
  constructor(
    private readonly bloques: FacturacionBloqueService,
    private readonly ingesta: FacturacionBloqueIngestaService,
    private readonly entrega: FacturacionBloqueEntregaService,
  ) {}

  @Get()
  @CheckAbility({ action: 'create', subject: 'Documento' })
  listar(@Query() filtros: ListarBloquesDto): Promise<BloqueFacturacion[]> {
    return this.bloques.listar(filtros);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Documento' })
  crear(
    @Body() dto: CrearBloqueDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<SubidaBloqueIniciada> {
    return this.bloques.crear(dto, user);
  }

  @Get(':id')
  @CheckAbility({ action: 'create', subject: 'Documento' })
  detalle(@Param('id') id: string): Promise<BloqueFacturacionDetalle> {
    return this.bloques.detalle(id);
  }

  /** Detects the unit of every page and stores one PDF per unit. Sends NOTHING. */
  @Patch(':id/confirmar')
  @CheckAbility({ action: 'create', subject: 'Documento' })
  confirmar(@Param('id') id: string): Promise<ReporteIngestaBloque> {
    return this.ingesta.procesar(id);
  }

  /**
   * THE explicit send: delivers to the residents inside this request. Calling it
   * again resumes a delivery that failed or was cut short and never re-sends to
   * somebody already reached; a block already `enviado` is a 409. The sender is
   * the caller's account.
   */
  @Post(':id/enviar')
  @HttpCode(200)
  @CheckAbility({ action: 'manage', subject: 'Documento' })
  enviar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<BloqueFacturacion> {
    return this.entrega.enviar(id, user);
  }

  @Get(':id/descargar')
  @CheckAbility({ action: 'create', subject: 'Documento' })
  descargar(@Param('id') id: string): Promise<DescargaArchivo> {
    return this.bloques.descargarOriginal(id);
  }

  @Delete(':id')
  @CheckAbility({ action: 'manage', subject: 'Documento' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.bloques.eliminar(id);
  }
}
