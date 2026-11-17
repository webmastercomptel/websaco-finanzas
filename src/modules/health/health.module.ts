// src/modules/health/health.module.ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';
import { IntegracionComptableHealthIndicator } from './integracion-comptable.health';
import { CorreoHealthIndicator } from './correo.health';
import { FrontendUrlHealthIndicator } from './frontend-url.health';
import { PqrEstadosHealthIndicator } from './pqr-estados.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  // REDIS_CLIENT is provided by the @Global CommonModule; ConfigService by the
  // global ConfigModule.
  providers: [
    RedisHealthIndicator,
    IntegracionComptableHealthIndicator,
    CorreoHealthIndicator,
    FrontendUrlHealthIndicator,
    // The Pqr model comes from the global DatabaseModule.
    PqrEstadosHealthIndicator,
  ],
})
export class HealthModule {}
