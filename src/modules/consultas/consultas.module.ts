import { Module } from '@nestjs/common';
import { ConsultasController } from './consultas.controller';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';

@Module({
  controllers: [ConsultasController],
  providers: [AuxiliarCarteraService],
})
export class ConsultasModule {}
