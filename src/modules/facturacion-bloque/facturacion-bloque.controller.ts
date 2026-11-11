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
 * Every route is gated by a FINANZAS key on `Factura`, never an Administración
 * one: these PDFs are every unit's invoices and statements of account. The
 * profile does not matter: a `personal` team member who holds the invoice keys
 * reaches the routes like anybody else, and `/equipo` or a role can hand those
 * keys out only to someone who is allowed to receive them from a person who
 * holds them (the delegation cap, `casl/delegacion.ts`). Without them, no
 * Administración key opens anything here.
 *
 * - `create Factura` (`facturas.crear`) for list, detail, upload, ingest and the
 *   original. NOT `read`: these routes expose every unit's documents at once.
 * - `approve Factura` (`facturas.aprobar`) for the SEND and the delete, the same
 *   key the native invoice send uses: releasing documents to residents is a
 *   decision separate from producing them.
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
  @CheckAbility({ action: 'create', subject: 'Factura' })
  listar(@Query() filtros: ListarBloquesDto): Promise<BloqueFacturacion[]> {
    return this.bloques.listar(filtros);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Factura' })
  crear(
    @Body() dto: CrearBloqueDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<SubidaBloqueIniciada> {
    return this.bloques.crear(dto, user);
  }

  @Get(':id')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  detalle(@Param('id') id: string): Promise<BloqueFacturacionDetalle> {
    return this.bloques.detalle(id);
  }

  /** Detects the unit of every page and stores one PDF per unit. Sends NOTHING. */
  @Patch(':id/confirmar')
  @CheckAbility({ action: 'create', subject: 'Factura' })
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
  @CheckAbility({ action: 'approve', subject: 'Factura' })
  enviar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<BloqueFacturacion> {
    return this.entrega.enviar(id, user);
  }

  @Get(':id/descargar')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  descargar(@Param('id') id: string): Promise<DescargaArchivo> {
    return this.bloques.descargarOriginal(id);
  }

  @Delete(':id')
  @CheckAbility({ action: 'approve', subject: 'Factura' })
  eliminar(@Param('id') id: string): Promise<{ id: string }> {
    return this.bloques.eliminar(id);
  }
}
