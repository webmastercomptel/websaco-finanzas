import { Module } from '@nestjs/common';
import { FacturasController } from './facturas.controller';
import { FacturasService } from './facturas.service';
import { LotesController } from './lotes.controller';
import { LotesFacturacionService } from './lotes.service';
import { ConsultaFacturacionService } from './consulta-facturacion.service';
import { ReiniciarCicloController } from './reiniciar-ciclo.controller';
import { ReiniciarCicloService } from './reiniciar-ciclo.service';

@Module({
  controllers: [FacturasController, LotesController, ReiniciarCicloController],
  providers: [
    FacturasService,
    LotesFacturacionService,
    ConsultaFacturacionService,
    ReiniciarCicloService,
  ],
  // Exported so Recibos/NotasCredito/NotasDebito/NotasContables can inject
  // LotesFacturacionService and call exigirSinLoteAbierto() before creating
  // their own documents — see each of those modules' own imports.
  exports: [LotesFacturacionService],
})
export class FacturacionModule {}
