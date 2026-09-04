import { Module } from '@nestjs/common';
import { NotasCreditoController } from './notas-credito.controller';
import { NotasCreditoService } from './notas-credito.service';
import { RecibosModule } from '../recibos/recibos.module';
import { FacturacionModule } from '../facturacion/facturacion.module';

@Module({
  imports: [RecibosModule, FacturacionModule],
  controllers: [NotasCreditoController],
  providers: [NotasCreditoService],
})
export class NotasCreditoModule {}
