// src/modules/configuracion/configuracion.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CuentasContablesController } from './cuentas-contables/cuentas-contables.controller';
import { CuentasContablesService } from './cuentas-contables/cuentas-contables.service';
import { ParametrosController } from './parametros/parametros.controller';
import { ParametrosService } from './parametros/parametros.service';
import { DocumentosController } from './documentos/documentos.controller';
import { DocumentosService } from './documentos/documentos.service';
import { InterfazContableController } from './interfaz-contable/interfaz-contable.controller';
import { InterfazContableService } from './interfaz-contable/interfaz-contable.service';
import {
  CuentaContable,
  CuentaContableSchema,
} from '../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  InterfazContable as InterfazContableSchemaClass,
  InterfazContableSchema,
} from '../../database/schemas/contabilidad/interfaz-contable.schema';
import {
  Copropiedad,
  CopropiedadSchema,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  ConceptoCobro,
  ConceptoCobroSchema,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoSchema,
} from '../../database/schemas/numeracion/consecutivo-documento.schema';
import {
  ResolucionFacturacion,
  ResolucionFacturacionSchema,
} from '../../database/schemas/numeracion/resolucion-facturacion.schema';
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

/**
 * Houses the four Configuración screens: Maestro de Cuentas, Parámetros de
 * Facturación, Tabla de Documentos, and Interfaz Contable. All share one
 * CASL subject (`Configuracion`) and one nav group.
 *
 * Registers every schema its four services inject directly via
 * `MongooseModule.forFeature`, matching `ConsultasModule`/`PanelControlModule`'s
 * established pattern for reading schemas this module doesn't own — Recibo/
 * NotaCredito/NotaDebito/NotaContable are needed only by DocumentosService's
 * already-issued-number guardrail (§5), never mutated here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CuentaContable.name, schema: CuentaContableSchema },
      {
        name: InterfazContableSchemaClass.name,
        schema: InterfazContableSchema,
      },
      { name: Copropiedad.name, schema: CopropiedadSchema },
      { name: ConceptoCobro.name, schema: ConceptoCobroSchema },
      { name: ConsecutivoDocumento.name, schema: ConsecutivoDocumentoSchema },
      { name: ResolucionFacturacion.name, schema: ResolucionFacturacionSchema },
      { name: Recibo.name, schema: ReciboSchema },
      { name: NotaCredito.name, schema: NotaCreditoSchema },
      { name: NotaDebito.name, schema: NotaDebitoSchema },
      { name: NotaContable.name, schema: NotaContableSchema },
    ]),
  ],
  controllers: [
    CuentasContablesController,
    ParametrosController,
    DocumentosController,
    InterfazContableController,
  ],
  providers: [
    CuentasContablesService,
    ParametrosService,
    DocumentosService,
    InterfazContableService,
  ],
})
export class ConfiguracionModule {}
