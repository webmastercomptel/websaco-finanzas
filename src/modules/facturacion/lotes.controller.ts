// src/modules/facturacion/lotes.controller.ts
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LotesFacturacionService } from './lotes.service';
import { CrearLoteDto } from './dto/crear-lote.dto';
import { CargarNovedadesDto } from './dto/cargar-novedades.dto';
import type {
  ErrorConsolidacion,
  LoteFacturacion,
  LoteFacturacionDetalle,
  ResultadoCargaNovedades,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * The monthly billing cycle: define a run, upload novedades, liquidar
 * (preview), consolidar (commit). `subject: 'Factura'` throughout — there is
 * no separate CASL subject for a Lote; provisioning invoices in bulk is the
 * same capability as issuing one.
 */
@Controller('lotes')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class LotesController {
  constructor(private readonly lotes: LotesFacturacionService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findAll(): Promise<LoteFacturacion[]> {
    return this.lotes.findAll();
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findOne(@Param('id') id: string): Promise<LoteFacturacionDetalle> {
    return this.lotes.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Factura' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearLoteDto,
  ): Promise<LoteFacturacion> {
    // PoliciesGuard already required a Factura/create permission, which only
    // an account with an active assignment can hold — accountId is
    // guaranteed set here, unlike on the account-less-allowed /auth/me route.
    return this.lotes.crear(user.accountId!, dto);
  }

  @Post(':id/novedades')
  @CheckAbility({ action: 'update', subject: 'Factura' })
  cargarNovedades(
    @Param('id') id: string,
    @Body() dto: CargarNovedadesDto,
  ): Promise<ResultadoCargaNovedades> {
    return this.lotes.cargarNovedades(id, dto.filas);
  }

  @Post(':id/liquidar')
  @CheckAbility({ action: 'update', subject: 'Factura' })
  liquidar(@Param('id') id: string): Promise<LoteFacturacion> {
    return this.lotes.liquidar(id);
  }

  @Post(':id/consolidar')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  consolidar(
    @Param('id') id: string,
  ): Promise<{ lote: LoteFacturacion; errores: ErrorConsolidacion[] }> {
    return this.lotes.consolidar(id);
  }
}
