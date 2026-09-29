import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';
import { RecibosController } from './recibos.controller';
import { RecibosService } from './recibos.service';
import { LoteRecibosController } from './lote-recibos.controller';
import { LoteRecibosService } from './lote-recibos.service';
import { FacturacionModule } from '../facturacion/facturacion.module';
import { AplicacionLoteRecibosProcessor } from './colas/aplicacion-lote-recibos.processor';
import {
  EVENTOS_COLA_APLICACION_LOTE_RECIBOS,
  NOMBRE_COLA_APLICACION_LOTE_RECIBOS,
} from './colas/aplicacion-lote-recibos.constants';

@Module({
  imports: [
    FacturacionModule,
    BullModule.registerQueue({ name: NOMBRE_COLA_APLICACION_LOTE_RECIBOS }),
  ],
  controllers: [RecibosController, LoteRecibosController],
  providers: [
    RecibosService,
    LoteRecibosService,
    AplicacionLoteRecibosProcessor,
    {
      provide: EVENTOS_COLA_APLICACION_LOTE_RECIBOS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): QueueEvents =>
        new QueueEvents(NOMBRE_COLA_APLICACION_LOTE_RECIBOS, {
          connection: { url: config.get<string>('app.redisUrl') },
        }),
    },
  ],
  exports: [RecibosService],
})
export class RecibosModule {}
