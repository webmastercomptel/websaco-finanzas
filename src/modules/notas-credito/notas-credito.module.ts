import { Module } from '@nestjs/common';
import { NotasCreditoController } from './notas-credito.controller';
import { NotasCreditoService } from './notas-credito.service';
import { RecibosModule } from '../recibos/recibos.module';

@Module({
  imports: [RecibosModule],
  controllers: [NotasCreditoController],
  providers: [NotasCreditoService],
})
export class NotasCreditoModule {}
