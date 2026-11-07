// src/modules/actividades/actividades.module.ts
import { Module } from '@nestjs/common';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { ActividadesController } from './actividades.controller';
import { ActividadesPortalController } from './actividades-portal.controller';
import { ActividadesService } from './actividades.service';

/**
 * Models come from the @Global DatabaseModule; guards, tenant context, the
 * lock, the directory, mail and access links from CommonModule. Imports the
 * inbox module to notify residents of a new activity.
 */
@Module({
  imports: [NotificacionesModule],
  controllers: [ActividadesController, ActividadesPortalController],
  providers: [ActividadesService],
})
export class ActividadesModule {}
