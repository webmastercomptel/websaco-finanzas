import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConsultasController } from './consultas.controller';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';
import { VencimientosCarteraService } from './vencimientos-cartera.service';
import {
  Factura,
  FacturaSchema,
} from '../../database/schemas/facturacion/factura.schema';
import {
  Recibo,
  ReciboSchema,
} from '../../database/schemas/recibos/recibo.schema';
import {
  NotaCredito,
  NotaCreditoSchema,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoSchema,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  NotaContable,
  NotaContableSchema,
} from '../../database/schemas/notas-contables/nota-contable.schema';
import {
  AplicacionCartera,
  AplicacionCarteraSchema,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  SaldoCartera,
  SaldoCarteraSchema,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  Inmueble,
  InmuebleSchema,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroSchema,
} from '../../database/schemas/terceros/tercero.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Factura.name, schema: FacturaSchema },
      { name: Recibo.name, schema: ReciboSchema },
      { name: NotaCredito.name, schema: NotaCreditoSchema },
      { name: NotaDebito.name, schema: NotaDebitoSchema },
      { name: NotaContable.name, schema: NotaContableSchema },
      { name: AplicacionCartera.name, schema: AplicacionCarteraSchema },
      { name: SaldoCartera.name, schema: SaldoCarteraSchema },
      { name: Inmueble.name, schema: InmuebleSchema },
      { name: Tercero.name, schema: TerceroSchema },
    ]),
  ],
  controllers: [ConsultasController],
  providers: [AuxiliarCarteraService, VencimientosCarteraService],
})
export class ConsultasModule {}
