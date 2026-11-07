// src/modules/panel-administracion/panel-administracion-portal.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { ResumenPanelAdministracion } from '../../contracts';
import { Modulo } from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { PanelAdministracionService } from './panel-administracion.service';

/**
 * Resident side of the dashboard: published announcements and the caller's OWN
 * PQRs and bookings. Guarded by `PortalGuard` (the caller must hold a unit of
 * the ACTIVE coproperty, which must have contracted the module) and
 * deliberately NOT by CASL: residents carry no permissions, and putting this
 * route behind `PoliciesGuard` would lock out exactly the people it is for.
 *
 * Authorization is data-level: the service narrows PQRs and bookings by the
 * caller's account. No financial figure and no payment link is served here;
 * owners' balances stay in the native `/portal` account statement. There is
 * only this one read route and there must not be a second one that widens it.
 */
@Controller('portal/panel')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('administracion')
export class PanelAdministracionPortalController {
  constructor(private readonly panel: PanelAdministracionService) {}

  @Get()
  resumen(
    @CurrentUser() user: IRequestUser,
  ): Promise<ResumenPanelAdministracion> {
    return this.panel.resumenResidente(user);
  }
}
