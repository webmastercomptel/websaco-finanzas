import { Module } from '@nestjs/common';
import { RecibosController } from './recibos.controller';
import { RecibosService } from './recibos.service';
import { LoteRecibosController } from './lote-recibos.controller';
import { LoteRecibosService } from './lote-recibos.service';
import { FacturacionModule } from '../facturacion/facturacion.module';

@Module({
  imports: [FacturacionModule],
  controllers: [RecibosController, LoteRecibosController],
  providers: [RecibosService, LoteRecibosService],
  exports: [RecibosService],
})
export class RecibosModule {}
