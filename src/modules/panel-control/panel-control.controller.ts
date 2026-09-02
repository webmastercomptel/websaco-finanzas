// src/modules/panel-control/panel-control.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { PanelControlService } from './panel-control.service';
import type { ResumenPanelControl } from '../../contracts';

/**
 * Dashboard endpoint for the super-admin panel. Returns the three KPIs:
 * total entities, active coproperties, and active users.
 *
 * `PlatformAdminGuard`: this is platform-operator-only data.
 */
@Controller('panel-control')
@UseGuards(FirebaseAuthGuard, PlatformAdminGuard)
export class PanelControlController {
  constructor(private readonly panelControl: PanelControlService) {}

  @Get('resumen')
  resumen(): Promise<ResumenPanelControl> {
    return this.panelControl.resumen();
  }
}
