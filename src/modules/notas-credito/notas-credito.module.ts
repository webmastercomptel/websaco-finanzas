import { Module } from '@nestjs/common';
import { NotasCreditoController } from './notas-credito.controller';
import { NotasCreditoService } from './notas-credito.service';

@Module({
  controllers: [NotasCreditoController],
  providers: [NotasCreditoService],
})
export class NotasCreditoModule {}
