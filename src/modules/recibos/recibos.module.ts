import { Module } from '@nestjs/common';
import { RecibosController } from './recibos.controller';
import { RecibosService } from './recibos.service';

@Module({
  controllers: [RecibosController],
  providers: [RecibosService],
  exports: [RecibosService],
})
export class RecibosModule {}
