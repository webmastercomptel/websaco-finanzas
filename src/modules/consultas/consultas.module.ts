import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConsultasController } from './consultas.controller';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';
import { VencimientosCarteraService } from './vencimientos-cartera.service';
import { CarteraGeneralService } from './cartera-general.service';
import { CarteraPorInmuebleService } from './cartera-por-inmueble.service';
import { CarteraPorConceptosService } from './cartera-por-conceptos.service';
import { EstadoCuentaService } from './estado-cuenta.service';
import { MovimientoContableService } from './movimiento-contable.service';
import { ConciliacionCarteraService } from './conciliacion-cartera.service';
import { ConsecutivosService } from './consecutivos.service';
import { InicioResumenService } from './inicio-resumen.service';
import { PistaAuditoriaService } from './pista-auditoria.service';
import {
  Factura,
  FacturaSchema,
} from '../../database/schemas/facturacion/factura.schema';
import {
  LoteFacturacion,
  LoteFacturacionSchema,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
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
import {
  AsientoContable,
  AsientoContableSchema,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  NotaAnticipo,
  NotaAnticipoSchema,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  CuentaContable,
  CuentaContableSchema,
} from '../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  Account,
  AccountSchema,
} from '../../database/schemas/cuentas/account.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Factura.name, schema: FacturaSchema },
      { name: LoteFacturacion.name, schema: LoteFacturacionSchema },
      { name: Recibo.name, schema: ReciboSchema },
      { name: NotaCredito.name, schema: NotaCreditoSchema },
      { name: NotaDebito.name, schema: NotaDebitoSchema },
      { name: NotaContable.name, schema: NotaContableSchema },
      { name: NotaAnticipo.name, schema: NotaAnticipoSchema },
      { name: AplicacionCartera.name, schema: AplicacionCarteraSchema },
      { name: SaldoCartera.name, schema: SaldoCarteraSchema },
      { name: ConceptoCobro.name, schema: ConceptoCobroSchema },
      { name: Inmueble.name, schema: InmuebleSchema },
      { name: Tercero.name, schema: TerceroSchema },
      { name: Copropiedad.name, schema: CopropiedadSchema },
      { name: AsientoContable.name, schema: AsientoContableSchema },
      { name: CuentaContable.name, schema: CuentaContableSchema },
      { name: Account.name, schema: AccountSchema },
    ]),
  ],
  controllers: [ConsultasController],
  providers: [
    AuxiliarCarteraService,
    VencimientosCarteraService,
    CarteraGeneralService,
    CarteraPorInmuebleService,
    CarteraPorConceptosService,
    EstadoCuentaService,
    MovimientoContableService,
    ConciliacionCarteraService,
    ConsecutivosService,
    InicioResumenService,
    PistaAuditoriaService,
  ],
})
export class ConsultasModule {}
