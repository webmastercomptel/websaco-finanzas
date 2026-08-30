// src/app.module.ts
import { Module } from '@nestjs/common';
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
import { CopropiedadesModule } from './modules/copropiedades/copropiedades.module';
import { RecibosModule } from './modules/recibos/recibos.module';
import { ConceptosModule } from './modules/conceptos/conceptos.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Bootstrap module: config, the database connection and its schemas, the
 * cross-cutting providers (Redis, Firebase, tenant context) and the
 * authorization layer.
 *
 * `MongooseModule.forRoot` opens the connection; `DatabaseModule` registers the
 * models on it and is @Global, so a feature module injects any model without
 * importing anything.
 *
 * Feature modules and BullMQ are added as they land.
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
    DatabaseModule,
    CommonModule,
    CaslModule,
    AuthModule,
    InmueblesModule,
    TercerosModule,
    FacturacionModule,
    RecibosModule,
    EntidadesModule,
    CopropiedadesModule,
    ConceptosModule,
    UsuariosModule,
    HealthModule,
  ],
})
export class AppModule {}
