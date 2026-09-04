import { Module } from '@nestjs/common';
import { NotasDebitoController } from './notas-debito.controller';
import { NotasDebitoService } from './notas-debito.service';
import { FacturacionModule } from '../facturacion/facturacion.module';

@Module({
  imports: [FacturacionModule],
  controllers: [NotasDebitoController],
  providers: [NotasDebitoService],
})
export class NotasDebitoModule {}
