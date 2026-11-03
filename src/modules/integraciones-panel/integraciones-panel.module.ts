// src/modules/integraciones-panel/integraciones-panel.module.ts
import { Module } from '@nestjs/common';
import { FirmaPanelGuard } from './firma-panel.guard';
import { IntegracionesPanelController } from './integraciones-panel.controller';
import { IntegracionesPanelService } from './integraciones-panel.service';
import { PanelHabilitadoGuard } from './panel-habilitado.guard';

/**
 * Inbound edge for the integrations panel. No `imports`: the Mongo models are
 * global via `DatabaseModule` and `ConfigService` via `ConfigModule`. Deleting
 * this module and its import from `app.module.ts` leaves every other module
 * compiling and passing (nothing imports it).
 */
@Module({
  controllers: [IntegracionesPanelController],
  providers: [FirmaPanelGuard, PanelHabilitadoGuard, IntegracionesPanelService],
})
export class IntegracionesPanelModule {}
