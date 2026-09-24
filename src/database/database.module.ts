// src/database/database.module.ts
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Copropiedad,
  CopropiedadSchema,
} from './schemas/copropiedades/copropiedad.schema';
import {
  ContadorCopropiedad,
  ContadorCopropiedadSchema,
} from './schemas/copropiedades/contador-copropiedad.schema';
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
  ContadorEntidadAdministradora,
  ContadorEntidadAdministradoraSchema,
} from './schemas/entidades/contador-entidad-administradora.schema';
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
  CarteraPorDocumento,
  CarteraPorDocumentoSchema,
} from './schemas/facturacion/cartera-por-documento.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoSchema,
} from './schemas/facturacion/saldo-total-documento.schema';
import {
  AsientoContable,
  AsientoContableSchema,
} from './schemas/facturacion/asiento-contable.schema';
import { Recibo, ReciboSchema } from './schemas/recibos/recibo.schema';
import {
  AplicacionCartera,
  AplicacionCarteraSchema,
} from './schemas/recibos/aplicacion-cartera.schema';
import {
  NotaCredito,
  NotaCreditoSchema,
} from './schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoSchema,
} from './schemas/notas-debito/nota-debito.schema';
import {
  NotaContable,
  NotaContableSchema,
} from './schemas/notas-contables/nota-contable.schema';
import {
  NotaAnticipo,
  NotaAnticipoSchema,
} from './schemas/notas-anticipo/nota-anticipo.schema';
import {
  CuentaContable,
  CuentaContableSchema,
} from './schemas/contabilidad/cuenta-contable.schema';
import {
  LoteRecibos,
  LoteRecibosSchema,
} from './schemas/recibos/lote-recibos.schema';
import {
  ConsecutivoLoteRecibos,
  ConsecutivoLoteRecibosSchema,
} from './schemas/recibos/consecutivo-lote-recibos.schema';
import {
  SaldoDocumentoOrigen,
  SaldoDocumentoOrigenSchema,
} from './schemas/recibos/saldo-documento-origen.schema';
import {
  LoteContabilidad,
  LoteContabilidadSchema,
} from './schemas/contabilidad/lote-contabilidad.schema';
import {
  ConsecutivoLoteContabilidad,
  ConsecutivoLoteContabilidadSchema,
} from './schemas/contabilidad/consecutivo-lote-contabilidad.schema';
import {
  SaldoInicial,
  SaldoInicialSchema,
} from './schemas/saldos-iniciales/saldo-inicial.schema';
import {
  LoteSaldoInicial,
  LoteSaldoInicialSchema,
} from './schemas/saldos-iniciales/lote-saldo-inicial.schema';
import {
  ConsecutivoSaldoInicial,
  ConsecutivoSaldoInicialSchema,
} from './schemas/saldos-iniciales/consecutivo-saldo-inicial.schema';
import {
  SaldoInicialAnticipo,
  SaldoInicialAnticipoSchema,
} from './schemas/saldos-iniciales/saldo-inicial-anticipo.schema';
import {
  LoteSaldoInicialAnticipo,
  LoteSaldoInicialAnticipoSchema,
} from './schemas/saldos-iniciales/lote-saldo-inicial-anticipo.schema';
import {
  ConsecutivoSaldoInicialAnticipo,
  ConsecutivoSaldoInicialAnticipoSchema,
} from './schemas/saldos-iniciales/consecutivo-saldo-inicial-anticipo.schema';
import {
  ProgresoImportacion,
  ProgresoImportacionSchema,
} from './schemas/importaciones/progreso-importacion.schema';
import {
  PresentacionDocumento,
  PresentacionDocumentoSchema,
} from './schemas/documentos/presentacion-documento.schema';
import {
  PlantillaDocumento,
  PlantillaDocumentoSchema,
} from './schemas/documentos/plantilla-documento.schema';
import {
  PublicacionLote,
  PublicacionLoteSchema,
} from './schemas/publicaciones/publicacion-lote.schema';

const models = [
  { name: EntidadAdministradora.name, schema: EntidadAdministradoraSchema },
  {
    name: ContadorEntidadAdministradora.name,
    schema: ContadorEntidadAdministradoraSchema,
  },
  { name: Copropiedad.name, schema: CopropiedadSchema },
  { name: ContadorCopropiedad.name, schema: ContadorCopropiedadSchema },
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
  { name: AplicacionCartera.name, schema: AplicacionCarteraSchema },
  { name: NotaCredito.name, schema: NotaCreditoSchema },
  { name: NotaDebito.name, schema: NotaDebitoSchema },
  { name: NotaContable.name, schema: NotaContableSchema },
  { name: NotaAnticipo.name, schema: NotaAnticipoSchema },
  { name: CuentaContable.name, schema: CuentaContableSchema },
  { name: LoteRecibos.name, schema: LoteRecibosSchema },
  { name: ConsecutivoLoteRecibos.name, schema: ConsecutivoLoteRecibosSchema },
  { name: CarteraPorDocumento.name, schema: CarteraPorDocumentoSchema },
  { name: SaldoDocumentoOrigen.name, schema: SaldoDocumentoOrigenSchema },
  { name: SaldoTotalDocumento.name, schema: SaldoTotalDocumentoSchema },
  { name: LoteContabilidad.name, schema: LoteContabilidadSchema },
  {
    name: ConsecutivoLoteContabilidad.name,
    schema: ConsecutivoLoteContabilidadSchema,
  },
  { name: LoteSaldoInicial.name, schema: LoteSaldoInicialSchema },
  { name: SaldoInicial.name, schema: SaldoInicialSchema },
  {
    name: ConsecutivoSaldoInicial.name,
    schema: ConsecutivoSaldoInicialSchema,
  },
  {
    name: LoteSaldoInicialAnticipo.name,
    schema: LoteSaldoInicialAnticipoSchema,
  },
  { name: SaldoInicialAnticipo.name, schema: SaldoInicialAnticipoSchema },
  {
    name: ConsecutivoSaldoInicialAnticipo.name,
    schema: ConsecutivoSaldoInicialAnticipoSchema,
  },
  { name: ProgresoImportacion.name, schema: ProgresoImportacionSchema },
  { name: PresentacionDocumento.name, schema: PresentacionDocumentoSchema },
  { name: PlantillaDocumento.name, schema: PlantillaDocumentoSchema },
  { name: PublicacionLote.name, schema: PublicacionLoteSchema },
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
