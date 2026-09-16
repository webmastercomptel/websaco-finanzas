import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { NotasCreditoService } from './notas-credito.service';
import { AnularFacturaDto } from './dto/anular-factura.dto';
import type { Factura } from '../../contracts';

/**
 * Routes `POST /facturas/:id/anular` — registered here, in
 * `NotasCreditoModule`, instead of `FacturasController`
 * (`FacturacionModule`), because voiding a Factura always creates a Nota
 * Crédito (`NotasCreditoService.anularFactura`, see its own docblock for the
 * full reasoning, including why the "obvious" `FacturasController` home
 * isn't reachable without crashing the app at boot). The route path is the
 * one a client actually cares about; which module happens to own the
 * controller class is not.
 *
 * CASL subject stays `Factura` (`facturas.anular`), matching the resource
 * this route actually annuls — a caller with `facturas.anular` but not
 * `notas-credito.crear` can still use this, same as every other "creates a
 * side document as an implementation detail" endpoint in this API.
 */
@Controller('facturas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class AnularFacturaController {
  constructor(private readonly notasCredito: NotasCreditoService) {}

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'Factura' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularFacturaDto,
  ): Promise<Factura> {
    return this.notasCredito.anularFactura(id, dto, user.accountId!);
  }
}
