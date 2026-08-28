// src/main.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import './common/dns-setup';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

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
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  configureApp(app, {
    env: configService.get<string>('app.env'),
    corsOrigins: configService.get<string>('app.corsOrigins'),
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
