// src/modules/zonas/zonas.module.ts
import { Module } from '@nestjs/common';
import { ZonasController } from './zonas.controller';
import { ZonasImagenService } from './zonas-imagen.service';
import { ZonasPortalController } from './zonas-portal.controller';
import { ZonasService } from './zonas.service';

/**
 * Models come from the @Global DatabaseModule; guards, tenant context and the
 * storage bucket from CommonModule. `PortalGuard` is instantiated by Nest where
 * it is used (it only needs the `Reflector`).
 */
@Module({
  controllers: [ZonasController, ZonasPortalController],
  providers: [ZonasService, ZonasImagenService],
})
export class ZonasModule {}
