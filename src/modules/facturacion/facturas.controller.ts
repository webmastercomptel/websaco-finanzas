// src/modules/facturacion/facturas.controller.ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { FacturasService } from './facturas.service';
import { GeneracionDocumentoService } from '../../common/documentos/generacion-documento.service';
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
  constructor(
    private readonly facturas: FacturasService,
    private readonly generacion: GeneracionDocumentoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findAll(@Query() query: ListarFacturasDto): Promise<Paginado<Factura>> {
    return this.facturas.findAll(query);
  }

  /**
   * `Factura.objectPath`/`generatedAt` (frozen once, per invoice, via the
   * batch `solicitar-generacion`/`confirmar-generacion` pair on
   * `LotesController`) are just fields on the same mapped contract — no PDF
   * is built or streamed by this backend, the browser renders it
   * client-side from `plantilla_documento` + `FacturasService.datosPlantilla`.
   */
  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findOne(@Param('id') id: string): Promise<Factura> {
    return this.facturas.findOne(id);
  }

  /**
   * A short-lived signed URL to read back this Factura's already-generated
   * PDF. Gated by the same `read` action as `findOne` above — nothing about
   * downloading an already-emitted document needs a stricter permission
   * than viewing it.
   */
  @Get(':id/url-lectura')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async urlLectura(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const factura = await this.facturas.findOne(id);
    return this.generacion.urlLectura('La factura', id, factura);
  }
}
