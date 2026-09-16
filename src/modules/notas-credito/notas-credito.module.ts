import { Module } from '@nestjs/common';
import { NotasCreditoController } from './notas-credito.controller';
import { NotasCreditoService } from './notas-credito.service';
import { AnularFacturaController } from './anular-factura.controller';
import { RecibosModule } from '../recibos/recibos.module';
import { FacturacionModule } from '../facturacion/facturacion.module';

@Module({
  imports: [RecibosModule, FacturacionModule],
  // `AnularFacturaController` (routes `/facturas/:id/anular`) lives here,
  // not in FacturacionModule, purely to avoid a circular require() graph —
  // see FacturacionModule's own comment on why the reverse import crashes
  // at boot. It needs NotasCreditoService directly (voiding an invoice
  // creates a full-amount Nota Crédito via that service's own `crear()`),
  // which only this module can provide it without that cycle.
  controllers: [NotasCreditoController, AnularFacturaController],
  providers: [NotasCreditoService],
})
export class NotasCreditoModule {}
