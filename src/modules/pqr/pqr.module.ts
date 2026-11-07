import { Module } from '@nestjs/common';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { PortalAccesoService } from '../portal/portal-acceso.service';
import { PqrAdjuntosService } from './pqr-adjuntos.service';
import { PqrCierreAutomaticoService } from './pqr-cierre-automatico.service';
import { PqrNotificacionesService } from './pqr-notificaciones.service';
import { PqrPortalController } from './pqr-portal.controller';
import { PqrController } from './pqr.controller';
import { PqrService } from './pqr.service';

/**
 * Models come from the @Global DatabaseModule; guards, tenant context, the
 * lock, the directory, mail, access links and the storage bucket from
 * CommonModule. Imports the inbox module to notify staff and authors.
 *
 * `PortalAccesoService` is provided here instead of imported because
 * `PortalModule` is a leaf nothing imports (so it cannot close a cycle); the
 * service is stateless and only reads two models, so a second instance is
 * harmless and the derivation of "which units does this resident hold" stays
 * the single one.
 */
@Module({
  imports: [NotificacionesModule],
  controllers: [PqrController, PqrPortalController],
  providers: [
    PqrService,
    PqrNotificacionesService,
    PqrAdjuntosService,
    PqrCierreAutomaticoService,
    PortalAccesoService,
  ],
})
export class PqrModule {}
