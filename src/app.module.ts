// src/app.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

// Configuration
import appConfig from './config/app.config';
import { envValidationSchema } from './config/env.validation';

// Core modules
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { CaslModule } from './modules/casl/casl.module';
import { AuthModule } from './modules/auth/auth.module';
import { InmueblesModule } from './modules/inmuebles/inmuebles.module';
import { TercerosModule } from './modules/terceros/terceros.module';
import { FacturacionModule } from './modules/facturacion/facturacion.module';
import { EntidadesModule } from './modules/entidades/entidades.module';
import { PlantillasDocumentoModule } from './modules/plantillas-documento/plantillas-documento.module';
import { CopropiedadesModule } from './modules/copropiedades/copropiedades.module';
import { RecibosModule } from './modules/recibos/recibos.module';
import { NotasCreditoModule } from './modules/notas-credito/notas-credito.module';
import { NotasDebitoModule } from './modules/notas-debito/notas-debito.module';
import { NotasContablesModule } from './modules/notas-contables/notas-contables.module';
import { NotasAnticipoModule } from './modules/notas-anticipo/notas-anticipo.module';
import { SaldosInicialesModule } from './modules/saldos-iniciales/saldos-iniciales.module';
import { ConceptosModule } from './modules/conceptos/conceptos.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { ConsultasModule } from './modules/consultas/consultas.module';
import { AuditoriaModule } from './modules/auditoria/auditoria.module';
import { PanelControlModule } from './modules/panel-control/panel-control.module';
import { ConfiguracionModule } from './modules/configuracion/configuracion.module';
import { HealthModule } from './modules/health/health.module';
import { CatalogosModule } from './modules/catalogos/catalogos.module';
import { AdicionContabilidadModule } from './modules/adicion-contabilidad/adicion-contabilidad.module';
import { PublicacionFacturasModule } from './modules/publicacion-facturas/publicacion-facturas.module';

/**
 * Bootstrap module: config, the database connection and its schemas, the
 * cross-cutting providers (Redis, Firebase, tenant context) and the
 * authorization layer.
 *
 * `MongooseModule.forRoot` opens the connection; `DatabaseModule` registers the
 * models on it and is @Global, so a feature module injects any model without
 * importing anything.
 *
 * `BullModule.forRootAsync` opens the one shared Redis connection every
 * queue in the app reuses — feature modules only `registerQueue` their own
 * queue name on top of it (see `FacturacionModule`, the first consumer).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validationSchema: envValidationSchema,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('app.mongodbUri'),
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.get<string>('app.redisUrl') },
      }),
    }),
    // Stays even if PublicacionFacturasModule is ever rolled back —
    // LotesController itself injects EventEmitter2 to emit the domain fact.
    EventEmitterModule.forRoot(),
    DatabaseModule,
    CommonModule,
    CaslModule,
    AuthModule,
    InmueblesModule,
    TercerosModule,
    FacturacionModule,
    RecibosModule,
    NotasCreditoModule,
    NotasDebitoModule,
    NotasContablesModule,
    NotasAnticipoModule,
    SaldosInicialesModule,
    EntidadesModule,
    PlantillasDocumentoModule,
    CopropiedadesModule,
    ConceptosModule,
    UsuariosModule,
    ConsultasModule,
    AuditoriaModule,
    PanelControlModule,
    ConfiguracionModule,
    HealthModule,
    CatalogosModule,
    AdicionContabilidadModule,
    PublicacionFacturasModule,
  ],
})
export class AppModule {}
