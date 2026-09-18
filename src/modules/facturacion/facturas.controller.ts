// src/modules/facturacion/facturas.controller.ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { FacturasService } from './facturas.service';
import { ListarFacturasDto } from './dto/listar-facturas.dto';
import type { Factura, Paginado } from '../../contracts';

/**
 * Read-only: invoices are only ever created via a Lote's consolidación
 * (LotesController). There is no create/update/delete here, and there must
 * not be one — a Factura's fields are frozen by design.
 *
 * `POST /facturas/:id/anular` (the `annul` exception "the audit law" always
 * allows) is NOT here — see `AnularFacturaController`
 * (`modules/notas-credito/`) for why it lives in that module instead despite
 * the route path.
 */
@Controller('facturas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class FacturasController {
  constructor(private readonly facturas: FacturasService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findAll(@Query() query: ListarFacturasDto): Promise<Paginado<Factura>> {
    return this.facturas.findAll(query);
  }

  /**
   * Also the frontend's source for rendering a Factura's PDF client-side —
   * `Factura.documentDefinition` (frozen once, at `consolidar()` time, no
   * "DUPLICADO" variant baked in — reprinting a duplicate copy is a
   * client-side concern now, not something this route does server-side) is
   * just another field on the same mapped contract, so there's no separate
   * `:id/pdf` route anymore.
   */
  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findOne(@Param('id') id: string): Promise<Factura> {
    return this.facturas.findOne(id);
  }
}
