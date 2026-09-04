import { Module } from '@nestjs/common';
import { NotasContablesController } from './notas-contables.controller';
import { NotasContablesService } from './notas-contables.service';
import { FacturacionModule } from '../facturacion/facturacion.module';

@Module({
  imports: [FacturacionModule],
  controllers: [NotasContablesController],
  providers: [NotasContablesService],
})
export class NotasContablesModule {}
