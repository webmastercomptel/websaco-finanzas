// src/modules/anuncios/anuncios.module.ts
import { Module } from '@nestjs/common';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { AnunciosEntregaService } from './anuncios-entrega.service';
import { AnunciosPortalController } from './anuncios-portal.controller';
import { AnunciosController } from './anuncios.controller';
import { AnunciosService } from './anuncios.service';

/**
 * Models come from the @Global DatabaseModule; guards, tenant context, the
 * directory, mail and access links from CommonModule. Imports the inbox module
 * to notify residents. No queue and no worker: delivery happens inside the
 * publish request (see `AnunciosEntregaService`).
 */
@Module({
  imports: [NotificacionesModule],
  controllers: [AnunciosController, AnunciosPortalController],
  providers: [AnunciosService, AnunciosEntregaService],
})
export class AnunciosModule {}
