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
  // Joi default 'all'; see APP_ROLE in env.validation.ts.
  appRole: process.env.APP_ROLE!,
  // Joi default 1 (Cloud Run); see TRUST_PROXY_HOPS in env.validation.ts.
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS!, 10),
  mongodbUri: process.env.MONGODB_URI!,
  redisUrl: process.env.REDIS_URL!,
  firebaseServiceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64!,
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET!,
  rootAdminEmail: process.env.ROOT_ADMIN_EMAIL!,
  // Genuinely optional outside production (see env.validation.ts), not a
  // silently defaulted value.
  corsOrigins: process.env.CORS_ORIGINS,
  // Comptable integration — both optional, present together or not at all
  // (`.and()` in env.validation.ts). Absent means "not configured", which the
  // screen reports; never a boot error.
  comptableApiUrl: process.env.COMPTABLE_API_URL,
  comptableHmacSecret: process.env.COMPTABLE_HMAC_SECRET,
  // Outgoing email — key and sender present together or not at all (`.and()`
  // in env.validation.ts); absent means "email not configured". The display
  // name always has a Joi default.
  sendgridApiKey: process.env.SENDGRID_API_KEY,
  sendgridFromEmail: process.env.SENDGRID_FROM_EMAIL,
  sendgridFromName: process.env.SENDGRID_FROM_NAME!,
  // Web app address for links in emails; optional (see env.validation.ts).
  frontendUrl: process.env.FRONTEND_URL,
  // Integrations panel — the secret is required by Joi only when the switch is
  // on; the switch is off unless explicitly set (see env.validation.ts).
  panelHmacSecret: process.env.PANEL_HMAC_SECRET,
  integracionPanelHabilitada:
    process.env.INTEGRACION_PANEL_HABILITADA?.toLowerCase() === 'true',
}));
