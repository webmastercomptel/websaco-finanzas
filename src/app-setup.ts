// src/app-setup.ts
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { corsOptionsFor } from './config/cors';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

/** Everything the wire contract depends on, in one place. */
export interface AppSetupOptions {
  /** NODE_ENV — decides how strict the CORS policy is. */
  env: string | undefined;
  /** CORS_ORIGINS, comma-separated. */
  corsOrigins: string | undefined;
}

/**
 * Applies the global configuration: route prefix, CORS, input validation and
 * the response envelope.
 *
 * This lives apart from `bootstrap()` so it can be exercised against a real
 * HTTP app in a test. That separation is not ceremony — twice the browser app
 * broke because a piece of this was absent, and both times every unit test on
 * both sides stayed green, because each one asked "does this class behave?"
 * and none asked "is it actually switched on?".
 *
 * Anything that shapes what goes over the wire belongs here, not in
 * `bootstrap()`, so the test keeps covering it.
 */
export function configureApp(
  app: INestApplication,
  options: AppSetupOptions,
): void {
  app.setGlobalPrefix('api/v1');

  // The browser app is served from a different origin (Vite in development, a
  // separate host in production), so every call it makes is cross-origin.
  // Without this the browser blocks the response and the client sees an opaque
  // "Network Error" that looks like the server is down.
  app.enableCors(corsOptionsFor(options.env, options.corsOrigins));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Every successful response ships as { statusCode, data }. The browser
  // client unwraps that shape, so a bare payload reaches it as `undefined`.
  app.useGlobalInterceptors(new TransformInterceptor());
}
