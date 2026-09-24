// src/modules/publicacion-facturas/publicacion-facturas.module.ts
import { Module } from '@nestjs/common';
import { PublicacionFacturasController } from './publicacion-facturas.controller';
import { PublicacionFacturasService } from './publicacion-facturas.service';
import { PublicacionFacturasListener } from './publicacion-facturas.listener';
import { SecretoProgramadorGuard } from './publicacion-facturas.guard';

/**
 * No `imports`: `PublicacionLote`'s model is global via `DatabaseModule`,
 * `DocumentoStorageService`/`ConfigService` are global via `CommonModule`
 * and `ConfigModule`. Same shape as `HealthModule`. Deleting this module and
 * its import from `app.module.ts` leaves every other module compiling
 * unchanged — see the rollback plan in proposal.md.
 */
@Module({
  controllers: [PublicacionFacturasController],
  providers: [
    PublicacionFacturasService,
    PublicacionFacturasListener,
    SecretoProgramadorGuard,
  ],
})
export class PublicacionFacturasModule {}
