import { Module } from '@nestjs/common';
import { NotasAnticipoController } from './notas-anticipo.controller';
import { NotasAnticipoService } from './notas-anticipo.service';
import { FacturacionModule } from '../facturacion/facturacion.module';

@Module({
  imports: [FacturacionModule],
  controllers: [NotasAnticipoController],
  providers: [NotasAnticipoService],
})
export class NotasAnticipoModule {}
