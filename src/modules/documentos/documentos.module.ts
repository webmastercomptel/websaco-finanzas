// src/modules/documentos/documentos.module.ts
import { Module } from '@nestjs/common';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { PortalAccesoService } from '../portal/portal-acceso.service';
import { CarpetasService } from './carpetas.service';
import { DocumentosActorService } from './documentos-actor.service';
import { DocumentosAlmacenService } from './documentos-almacen.service';
import { DocumentosHuerfanosService } from './documentos-huerfanos.service';
import { DocumentosNotificacionesService } from './documentos-notificaciones.service';
import { DocumentosPortalController } from './documentos-portal.controller';
import { DocumentosPortalService } from './documentos-portal.service';
import { DocumentosController } from './documentos.controller';
import { DocumentosService } from './documentos.service';

/**
 * Document library of the building (folders, files, per-folder rules, signed
 * uploads, the orphan-upload cron). Models come from the @Global
 * DatabaseModule; guards, tenant context, the lock, the directory, mail, access
 * links and the storage bucket from CommonModule. Imports the inbox module to
 * notify the audience of a new document.
 *
 * `PortalAccesoService` is provided here instead of imported because
 * `PortalModule` is a leaf nothing imports (so it cannot close a cycle); it is
 * stateless and reads two models, so a second instance is harmless and the
 * derivation of "which units does this resident hold" stays the single one.
 */
@Module({
  imports: [NotificacionesModule],
  controllers: [DocumentosController, DocumentosPortalController],
  providers: [
    CarpetasService,
    DocumentosService,
    DocumentosPortalService,
    DocumentosActorService,
    DocumentosAlmacenService,
    DocumentosNotificacionesService,
    DocumentosHuerfanosService,
    PortalAccesoService,
  ],
})
export class DocumentosModule {}
