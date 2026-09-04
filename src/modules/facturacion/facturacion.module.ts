import { Module } from '@nestjs/common';
import { FacturasController } from './facturas.controller';
import { FacturasService } from './facturas.service';
import { LotesController } from './lotes.controller';
import { LotesFacturacionService } from './lotes.service';

@Module({
  controllers: [FacturasController, LotesController],
  providers: [FacturasService, LotesFacturacionService],
  // Exported so Recibos/NotasCredito/NotasDebito/NotasContables can inject
  // LotesFacturacionService and call exigirSinLoteAbierto() before creating
  // their own documents — see each of those modules' own imports.
  exports: [LotesFacturacionService],
})
export class FacturacionModule {}
