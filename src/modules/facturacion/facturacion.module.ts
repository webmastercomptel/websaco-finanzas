import { Module } from '@nestjs/common';
import { FacturasController } from './facturas.controller';
import { FacturasService } from './facturas.service';
import { LotesController } from './lotes.controller';
import { LotesFacturacionService } from './lotes.service';

@Module({
  controllers: [FacturasController, LotesController],
  providers: [FacturasService, LotesFacturacionService],
})
export class FacturacionModule {}
