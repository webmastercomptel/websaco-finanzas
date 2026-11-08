// src/app-setup.ts
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { corsOptionsFor } from './config/cors';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

/** Everything the wire contract depends on, in one place. */
export interface AppSetupOptions {
  /** NODE_ENV — decides how strict the CORS policy is. */
  env: string | undefined;
  /** CORS_ORIGINS, comma-separated. */
  corsOrigins: string | undefined;
  /**
   * TRUST_PROXY_HOPS: exact number of proxies in front of the app (1 on Cloud
   * Run). Absent = 0, X-Forwarded-For ignored (never spoofable).
   */
  trustProxyHops?: number;
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

  // `req.ip` keys the per-address limit of the public access-link redeem.
  // A hop COUNT, never `true`: Express then takes the address the last N
  // proxies appended to X-Forwarded-For, not the left-most entry, which the
  // client writes itself.
  (app as NestExpressApplication).set(
    'trust proxy',
    options.trustProxyHops ?? 0,
  );

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
