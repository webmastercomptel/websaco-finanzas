// src/modules/facturacion-bloque/facturacion-bloque.module.ts
import { Module } from '@nestjs/common';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { PortalAccesoService } from '../portal/portal-acceso.service';
import { FacturacionBloqueAlmacenService } from './facturacion-bloque-almacen.service';
import { FacturacionBloqueEntregaService } from './facturacion-bloque-entrega.service';
import { FacturacionBloqueIngestaService } from './facturacion-bloque-ingesta.service';
import { FacturacionBloquePortalController } from './facturacion-bloque-portal.controller';
import { FacturacionBloquePortalService } from './facturacion-bloque-portal.service';
import { FacturacionBloqueController } from './facturacion-bloque.controller';
import { FacturacionBloqueService } from './facturacion-bloque.service';
import { LectorPdfBloque } from './lector-pdf-bloque';

/**
 * Block billing: ONE externally produced PDF with every unit's document, cut per
 * unit and sent to residents only on an explicit action. TRANSITIONAL adapter,
 * retired when the native invoice pipeline replaces it: it owns its folder, its
 * two collections and its Storage prefix, and NO other module imports it, so
 * removing it is deleting this folder plus its line in `AppModule`.
 *
 * Models come from the @Global DatabaseModule; guards, tenant context, the lock,
 * the directory, mail, access links and the storage bucket from CommonModule.
 * Imports the inbox module to notify residents. No queue and no worker: delivery
 * happens inside the send request (see `FacturacionBloqueEntregaService`).
 *
 * `PortalAccesoService` is provided here instead of imported for the same reason
 * as in `DocumentosModule`: `PortalModule` is a leaf nothing imports, it is
 * stateless and reads two models, and the derivation of "which units does this
 * resident hold" stays the single one.
 */
@Module({
  imports: [NotificacionesModule],
  controllers: [FacturacionBloqueController, FacturacionBloquePortalController],
  providers: [
    FacturacionBloqueService,
    FacturacionBloqueIngestaService,
    FacturacionBloqueEntregaService,
    FacturacionBloquePortalService,
    FacturacionBloqueAlmacenService,
    LectorPdfBloque,
    PortalAccesoService,
  ],
})
export class FacturacionBloqueModule {}
