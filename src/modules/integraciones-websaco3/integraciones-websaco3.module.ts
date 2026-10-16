// src/modules/integraciones-websaco3/integraciones-websaco3.module.ts
import { Module } from '@nestjs/common';
import { FirmaWebsaco3Guard } from './firma-websaco3.guard';
import { PropietariosController } from './propietarios.controller';
import { PropietariosService } from './propietarios.service';

/**
 * Inbound edge for the building-management system (WebSaco3 pulls from us),
 * separate from the outbound `PublicacionFacturasModule`. No `imports`: the
 * Mongo models are global via `DatabaseModule` and `ConfigService` via
 * `ConfigModule`. Deleting this module and its import from `app.module.ts`
 * leaves every other module compiling and passing (nothing imports it).
 */
@Module({
  controllers: [PropietariosController],
  providers: [PropietariosService, FirmaWebsaco3Guard],
})
export class IntegracionesWebsaco3Module {}
