// src/modules/envio-facturas/envio-facturas.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  PaginadoEnviosFactura,
  ResultadoMarcadoEnvio,
  ResultadoProcesoEnvio,
  ResumenEnvioFacturas,
} from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ListarEnviosFacturasDto } from './dto/listar-envios-facturas.dto';
import { MarcarEnvioFacturasDto } from './dto/marcar-envio-facturas.dto';
import { EnvioFacturasProcesoService } from './envio-facturas-proceso.service';
import { EnvioFacturasService } from './envio-facturas.service';

/**
 * Staff side of the native invoice send flow. NOTHING here runs by itself: an
 * invoice reaches residents only after somebody marks it (`marcar`) AND somebody
 * processes the queue (`procesar-pendientes`), two explicit actions.
 *
 * Permissions reuse the existing vocabulary (no new key): reading the queue is
 * `read Factura` (`facturas.ver`); marking and processing are `approve Factura`
 * (`facturas.aprobar`), a verb nothing used until now. Releasing an invoice to
 * residents is a decision of its own, so it is not folded into `create` (which
 * every billing clerk holds) or `update`.
 *
 * Residents never come through here: they read under `/portal/facturas`.
 */
@Controller('envio-facturas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('finanzas')
export class EnvioFacturasController {
  constructor(
    private readonly envios: EnvioFacturasService,
    private readonly proceso: EnvioFacturasProcesoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Factura' })
  listar(
    @Query() filtros: ListarEnviosFacturasDto,
  ): Promise<PaginadoEnviosFactura> {
    return this.envios.listar(filtros);
  }

  /** Declared before any `:id` route so it is never swallowed by a param. */
  @Get('resumen')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  resumen(): Promise<ResumenEnvioFacturas> {
    return this.envios.resumen();
  }

  /** Queues invoices for sending. Sends NOTHING. Idempotent. */
  @Post('marcar')
  @HttpCode(200)
  @CheckAbility({ action: 'approve', subject: 'Factura' })
  marcar(
    @Body() dto: MarcarEnvioFacturasDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoMarcadoEnvio> {
    return this.envios.marcar(dto, user);
  }

  /**
   * THE explicit send: delivers the next slice of the queue inside this request
   * and answers how far it got; the screen calls again while `hayMas` is true.
   * Safe to call twice at once or again after a cut request: nobody is notified
   * twice. The sender is the caller's account.
   */
  @Post('procesar-pendientes')
  @HttpCode(200)
  @CheckAbility({ action: 'approve', subject: 'Factura' })
  procesarPendientes(
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoProcesoEnvio> {
    return this.proceso.procesarPendientes(user);
  }
}
