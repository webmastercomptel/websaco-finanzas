import { registerAs } from '@nestjs/config';

/**
 * Returns the global application configuration object. Every value read here
 * with a non-null assertion is guaranteed present by Joi (env.validation.ts)
 * validating `process.env` before this factory is consulted — a genuine gap
 * must fail loudly at validation time, never hide behind a `??` fallback
 * here.
 * @returns {object} The application configuration (port, connection strings,
 * Firebase credential, bootstrap root address).
 */
export default registerAs('app', () => ({
  env: process.env.NODE_ENV,
  port: parseInt(process.env.PORT!, 10),
  mongodbUri: process.env.MONGODB_URI!,
  redisUrl: process.env.REDIS_URL!,
  firebaseServiceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64!,
  rootAdminEmail: process.env.ROOT_ADMIN_EMAIL!,
  // Genuinely optional outside production (see env.validation.ts), not a
  // silently defaulted value.
  corsOrigins: process.env.CORS_ORIGINS,
}));
