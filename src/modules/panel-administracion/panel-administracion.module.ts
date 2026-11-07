// src/modules/panel-administracion/panel-administracion.module.ts
import { Module } from '@nestjs/common';
import { PanelAdministracionPortalController } from './panel-administracion-portal.controller';
import { PanelAdministracionController } from './panel-administracion.controller';
import { PanelAdministracionService } from './panel-administracion.service';

/**
 * Read-only dashboard of the Administración side (staff and portal). Models come
 * from the @Global DatabaseModule and the guards, tenant context and
 * CaslAbilityFactory from the @Global CommonModule / CaslModule, so there is
 * nothing to import here.
 */
@Module({
  controllers: [
    PanelAdministracionController,
    PanelAdministracionPortalController,
  ],
  providers: [PanelAdministracionService],
})
export class PanelAdministracionModule {}
