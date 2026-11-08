// src/modules/portal/portal.controller.ts
import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { Modulo, ModuloAlguno } from '../casl/check-ability.decorator';
import {
  EstadoCuentaPortalDto,
  ListarFacturasPortalDto,
} from './dto/portal.dto';
import { PortalGuard } from './portal.guard';
import { PortalService } from './portal.service';

/**
 * The resident portal: what an owner or tenant sees of their own units.
 *
 * Read-only and deliberately small. There is NO receipts route here and must
 * not be one — receipts are internal. Owners get invoices and the statement of
 * account; tenants get invoices only (enforced in `PortalService`).
 */
@Controller('portal')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('finanzas')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  /**
   * The resident's own unit list. Shared by both products: the PQR and booking
   * forms (Administración) and the invoice screens (Finanzas) all start from it,
   * and it carries no financial data (code and role only). Invoices and the
   * statement stay Finanzas-only through the class-level `@Modulo`.
   */
  @ModuloAlguno('finanzas', 'administracion')
  @Get('unidades')
  unidades(@CurrentUser() user: IRequestUser) {
    return this.portal.unidades(user);
  }

  @Get('facturas')
  facturas(
    @Query() query: ListarFacturasPortalDto,
    @CurrentUser() user: IRequestUser,
  ) {
    return this.portal.facturasDe(user, query);
  }

  @Get('facturas/:id/documento-pdf')
  async documentoPdf(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const bytes = await this.portal.documentoPdfDeFactura(user, id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${id}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  @Get('estado-cuenta')
  estadoCuenta(
    @Query() query: EstadoCuentaPortalDto,
    @CurrentUser() user: IRequestUser,
  ) {
    return this.portal.estadoCuentaDe(user, query);
  }
}
