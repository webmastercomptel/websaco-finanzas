import { Module } from '@nestjs/common';
import { NotasDebitoController } from './notas-debito.controller';
import { NotasDebitoService } from './notas-debito.service';

@Module({
  controllers: [NotasDebitoController],
  providers: [NotasDebitoService],
})
export class NotasDebitoModule {}
