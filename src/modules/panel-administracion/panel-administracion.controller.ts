// src/modules/panel-administracion/panel-administracion.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { ResumenPanelAdministracion } from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { PanelAdministracionService } from './panel-administracion.service';

/**
 * Staff dashboard of the building-management side. It lives apart from the
 * financial `panel-control` (platform operator) on purpose: a coproperty may
 * have contracted only Administración, and this route is licence-gated to it.
 *
 * The gate `read Dashboard` (`dashboard.ver`) is only the door; the service
 * then decides block by block with the caller's other abilities, and an
 * unreadable block is omitted from the response. There is no query string and
 * no coproperty parameter: the tenant is the active one from the request.
 */
@Controller('panel-administracion')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class PanelAdministracionController {
  constructor(private readonly panel: PanelAdministracionService) {}

  @Get('resumen')
  @CheckAbility({ action: 'read', subject: 'Dashboard' })
  resumen(
    @CurrentUser() user: IRequestUser,
  ): Promise<ResumenPanelAdministracion> {
    return this.panel.resumenPersonal(user);
  }
}
