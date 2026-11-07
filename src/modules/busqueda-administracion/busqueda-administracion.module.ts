// src/modules/busqueda-administracion/busqueda-administracion.module.ts
import { Module } from '@nestjs/common';
import { DocumentosActorService } from '../documentos/documentos-actor.service';
import { BusquedaAdministracionController } from './busqueda-administracion.controller';
import { BusquedaAdministracionService } from './busqueda-administracion.service';

/**
 * Models come from the @Global DatabaseModule and the guards, tenant context,
 * AccesoService and CaslAbilityFactory from the @Global CommonModule /
 * CaslModule.
 *
 * `DocumentosActorService` is provided here instead of importing
 * `DocumentosModule` (which would drag in its controllers, uploads and the
 * orphan-upload cron for no reason): it is stateless and reads two models, so a
 * second instance is harmless and "which roles does this caller hold here"
 * keeps a single derivation. Same trade `DocumentosModule` made for
 * `PortalAccesoService`.
 */
@Module({
  controllers: [BusquedaAdministracionController],
  providers: [BusquedaAdministracionService, DocumentosActorService],
})
export class BusquedaAdministracionModule {}
