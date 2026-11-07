// src/modules/reservas/reservas.module.ts
import { Module } from '@nestjs/common';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { PortalAccesoService } from '../portal/portal-acceso.service';
import { ReservasController } from './reservas.controller';
import { ReservasNotificacionesService } from './reservas-notificaciones.service';
import { ReservasPortalController } from './reservas-portal.controller';
import { ReservasService } from './reservas.service';
import { ReservasVencimientoService } from './reservas-vencimiento.service';

/**
 * Models come from the @Global DatabaseModule; guards, tenant context, the
 * lock, the directory, mail and access links from CommonModule. Imports the
 * inbox module to notify staff and requesters.
 *
 * `PortalAccesoService` is provided here instead of imported because
 * `PortalModule` is a leaf nothing imports (so it cannot close a cycle); the
 * service is stateless and only reads two models, so a second instance is
 * harmless and the derivation of "which units does this resident hold" stays
 * the single one.
 */
@Module({
  imports: [NotificacionesModule],
  controllers: [ReservasController, ReservasPortalController],
  providers: [
    ReservasService,
    ReservasNotificacionesService,
    ReservasVencimientoService,
    PortalAccesoService,
  ],
})
export class ReservasModule {}
