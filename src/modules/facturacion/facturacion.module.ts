import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';
import { FacturasController } from './facturas.controller';
import { FacturasService } from './facturas.service';
import { LotesController } from './lotes.controller';
import { LotesFacturacionService } from './lotes.service';
import { ConsultaFacturacionService } from './consulta-facturacion.service';
import { ReiniciarCicloController } from './reiniciar-ciclo.controller';
import { ReiniciarCicloService } from './reiniciar-ciclo.service';
import { ConsolidacionProcessor } from './colas/consolidacion.processor';
import {
  EVENTOS_COLA_CONSOLIDACION,
  NOMBRE_COLA_CONSOLIDACION,
} from './colas/consolidacion.constants';

@Module({
  imports: [BullModule.registerQueue({ name: NOMBRE_COLA_CONSOLIDACION })],
  controllers: [FacturasController, LotesController, ReiniciarCicloController],
  providers: [
    FacturasService,
    LotesFacturacionService,
    ConsultaFacturacionService,
    ReiniciarCicloService,
    ConsolidacionProcessor,
    {
      provide: EVENTOS_COLA_CONSOLIDACION,
      inject: [ConfigService],
      // A plain `QueueEvents` instance, not Nest-managed — its own Redis
      // connection lives for the process's whole lifetime, same as
      // `REDIS_CLIENT`; never closed explicitly (one instance, negligible
      // resource, same acceptance as that shared client).
      useFactory: (config: ConfigService): QueueEvents =>
        new QueueEvents(NOMBRE_COLA_CONSOLIDACION, {
          connection: { url: config.get<string>('app.redisUrl') },
        }),
    },
  ],
  // Exported so Recibos/NotasCredito/NotasDebito/NotasContables can inject
  // LotesFacturacionService and call exigirSinLoteAbierto() before creating
  // their own documents — see each of those modules' own imports.
  //
  // NOT imported back by NotasCreditoModule the other way — RecibosModule
  // already imports FacturacionModule, and NotasCreditoModule imports
  // RecibosModule, so FacturacionModule importing NotasCreditoModule (even
  // via forwardRef) closes a real circular require() graph at the JS module
  // level, not just a NestJS DI cycle — forwardRef only defers provider
  // resolution, it doesn't defer the `import` statement itself, so this
  // crashes at boot ("Cannot access 'FacturacionModule' before
  // initialization"), confirmed by trying it. `AnularFacturaService`'s
  // anular-a-Factura feature (which needs NotasCreditoService) lives in
  // `NotasCreditoModule` instead, precisely to avoid this — see that
  // module's own comment.
  exports: [LotesFacturacionService],
})
export class FacturacionModule {}
