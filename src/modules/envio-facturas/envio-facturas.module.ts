// src/modules/envio-facturas/envio-facturas.module.ts
import { Module } from '@nestjs/common';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { EnvioFacturasController } from './envio-facturas.controller';
import { EnvioFacturasProcesoService } from './envio-facturas-proceso.service';
import { EnvioFacturasService } from './envio-facturas.service';

/**
 * Unified, explicit sending of NATIVE invoices to the owner and tenant of each
 * unit: `generado -> pendiente_envio -> enviado` (+ `error`), only by staff action,
 * delivered inside the request (no queue, no worker, no scheduler).
 *
 * Models come from the @Global DatabaseModule; the tenant context, the
 * directory, mail and access links from CommonModule. Imports the inbox and the
 * audit trail. No other module imports this one, and it imports no financial
 * module: it only points at the invoice by id. It replaces the retired HMAC
 * publication to the old building-management system.
 */
@Module({
  imports: [NotificacionesModule, AuditoriaModule],
  controllers: [EnvioFacturasController],
  providers: [EnvioFacturasService, EnvioFacturasProcesoService],
})
export class EnvioFacturasModule {}
