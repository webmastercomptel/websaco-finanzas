// src/main.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import './common/dns-setup';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { iniciarSentry } from './common/sentry/iniciar-sentry';
import { AppModule } from './app.module';
import { configureApp } from './app-setup';

/**
 * Bootstraps the NestJS application.
 *
 * Deliberately thin: everything that shapes the wire contract lives in
 * `configureApp`, which is covered by a test. Adding a global pipe, guard,
 * filter or interceptor here instead would put it outside that coverage.
 */
async function bootstrap() {
  // Before the app exists so start-up failures are captured. Read straight from
  // the environment because it must precede Nest; Joi still validates the DSN
  // when the app boots. Absent = Sentry off.
  iniciarSentry({
    dsn: process.env.SENTRY_DSN,
    env: process.env.NODE_ENV,
    release: process.env.K_REVISION,
  });
  // `rawBody` keeps the exact bytes of every request body: the integrations
  // panel signs its bodies and `FirmaPanelGuard` verifies over those bytes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  configureApp(app, {
    env: configService.get<string>('app.env'),
    corsOrigins: configService.get<string>('app.corsOrigins'),
    trustProxyHops: configService.get<number>('app.trustProxyHops'),
  });

  app.enableShutdownHooks();

  // PORT already has a Joi default (3000) in env.validation.ts — this `??` is
  // just a type-safety net for ConfigService.get's return type, not a fallback
  // for a genuinely missing/required value.
  const port = configService.get<number>('app.port') ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}/api/v1`);
}

void bootstrap().catch((error) => {
  console.error('Error bootstrapping the application', error);
});
