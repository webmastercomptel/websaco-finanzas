import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConsultasController } from './consultas.controller';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';
import { VencimientosCarteraService } from './vencimientos-cartera.service';
import { CarteraGeneralService } from './cartera-general.service';
import { EstadoCuentaService } from './estado-cuenta.service';
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
  ConceptoCobro,
  ConceptoCobroSchema,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  Inmueble,
  InmuebleSchema,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroSchema,
} from '../../database/schemas/terceros/tercero.schema';
import {
  Copropiedad,
  CopropiedadSchema,
} from '../../database/schemas/copropiedades/copropiedad.schema';

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
      { name: ConceptoCobro.name, schema: ConceptoCobroSchema },
      { name: Inmueble.name, schema: InmuebleSchema },
      { name: Tercero.name, schema: TerceroSchema },
      { name: Copropiedad.name, schema: CopropiedadSchema },
    ]),
  ],
  controllers: [ConsultasController],
  providers: [
    AuxiliarCarteraService,
    VencimientosCarteraService,
    CarteraGeneralService,
    EstadoCuentaService,
  ],
})
export class ConsultasModule {}
