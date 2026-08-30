// src/database/database.module.ts
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Copropiedad,
  CopropiedadSchema,
} from './schemas/copropiedades/copropiedad.schema';
import {
  Inmueble,
  InmuebleSchema,
} from './schemas/copropiedades/inmueble.schema';
import { Tercero, TerceroSchema } from './schemas/terceros/tercero.schema';
import {
  EntidadAdministradora,
  EntidadAdministradoraSchema,
} from './schemas/entidades/entidad-administradora.schema';
import {
  ConceptoCobro,
  ConceptoCobroSchema,
} from './schemas/conceptos/concepto-cobro.schema';
import {
  ValorRecurrente,
  ValorRecurrenteSchema,
} from './schemas/conceptos/valor-recurrente.schema';
import { Account, AccountSchema } from './schemas/cuentas/account.schema';
import {
  Asignacion,
  AsignacionSchema,
} from './schemas/cuentas/asignacion.schema';
import {
  ResolucionFacturacion,
  ResolucionFacturacionSchema,
} from './schemas/numeracion/resolucion-facturacion.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoSchema,
} from './schemas/numeracion/consecutivo-documento.schema';
import {
  ConsecutivoLote,
  ConsecutivoLoteSchema,
} from './schemas/facturacion/consecutivo-lote.schema';
import {
  PeriodoContable,
  PeriodoContableSchema,
} from './schemas/contabilidad/periodo-contable.schema';
import { Factura, FacturaSchema } from './schemas/facturacion/factura.schema';
import {
  LoteFacturacion,
  LoteFacturacionSchema,
} from './schemas/facturacion/lote-facturacion.schema';
import {
  SaldoCartera,
  SaldoCarteraSchema,
} from './schemas/facturacion/saldo-cartera.schema';
import {
  AsientoContable,
  AsientoContableSchema,
} from './schemas/facturacion/asiento-contable.schema';
import { Recibo, ReciboSchema } from './schemas/recibos/recibo.schema';
import {
  AplicacionRecibo,
  AplicacionReciboSchema,
} from './schemas/recibos/aplicacion-recibo.schema';

const models = [
  { name: EntidadAdministradora.name, schema: EntidadAdministradoraSchema },
  { name: Copropiedad.name, schema: CopropiedadSchema },
  { name: Inmueble.name, schema: InmuebleSchema },
  { name: Tercero.name, schema: TerceroSchema },
  { name: ConceptoCobro.name, schema: ConceptoCobroSchema },
  { name: ValorRecurrente.name, schema: ValorRecurrenteSchema },
  { name: Account.name, schema: AccountSchema },
  { name: Asignacion.name, schema: AsignacionSchema },
  { name: ResolucionFacturacion.name, schema: ResolucionFacturacionSchema },
  { name: ConsecutivoDocumento.name, schema: ConsecutivoDocumentoSchema },
  { name: ConsecutivoLote.name, schema: ConsecutivoLoteSchema },
  { name: PeriodoContable.name, schema: PeriodoContableSchema },
  { name: Factura.name, schema: FacturaSchema },
  { name: LoteFacturacion.name, schema: LoteFacturacionSchema },
  { name: SaldoCartera.name, schema: SaldoCarteraSchema },
  { name: AsientoContable.name, schema: AsientoContableSchema },
  { name: Recibo.name, schema: ReciboSchema },
  { name: AplicacionRecibo.name, schema: AplicacionReciboSchema },
];

/**
 * Registers every schema once, globally.
 *
 * Global so a feature module can inject any model without importing this, and
 * so a schema is never registered twice with different options — two
 * registrations of the same collection is the kind of divergence that surfaces
 * as an index existing in one place and not another.
 *
 * Schemas live under `schemas/<area>/`, not inside the feature modules that use
 * them: an invoice, a receipt and a report all read the same unit, and filing
 * that unit under whichever module happened to need it first would be arbitrary.
 */
@Global()
@Module({
  imports: [MongooseModule.forFeature(models)],
  exports: [MongooseModule],
})
export class DatabaseModule {}
