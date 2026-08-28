import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  // Both data services are managed and remote (MongoDB Atlas, Redis Cloud), so
  // each is configured with the single connection string its provider hands
  // you — one value to paste, nothing to assemble out of host/port/password.
  // A URI is also self-describing: credentials and TLS ride along in it, so
  // switching provider or enabling TLS changes this value and nothing else.
  // Checked by scheme only, deliberately NOT with Joi's `.uri()`: a MongoDB
  // connection string is not an RFC 3986 URI. Its authority may list several
  // hosts separated by commas (`host:27017,host:27017`), which a strict URI
  // parser rejects — a port must be digits only. That makes `.uri()` reject
  // the legacy (non-SRV) string Atlas hands you, which the driver parses
  // happily. Worse, Joi reports that failure as `string.uriCustomScheme` even
  // when the scheme is correct, so the operator is sent to inspect the one
  // part that was never wrong.
  //
  // The driver's parser is the authority on everything after the scheme;
  // duplicating its grammar here can only reject valid strings.
  MONGODB_URI: Joi.string()
    .pattern(/^mongodb(\+srv)?:\/\/\S+$/)
    .required()
    .messages({
      'string.pattern.base':
        'MONGODB_URI debe ser una cadena de conexión que empiece con ' +
        'mongodb:// o mongodb+srv:// (la que te da Atlas en "Connect").',
    }),

  // `rediss://` (two s) is the TLS form most managed providers hand out.
  //
  // Scheme-only, for the same reason as MONGODB_URI above: a generated Redis
  // password may contain `#` or `/`, which are structural characters to a
  // strict URI parser. `.uri()` rejects those strings even though ioredis
  // parses them, and — worse — reports the failure as `string.uriCustomScheme`,
  // so the operator is told the scheme is wrong when the scheme is the one part
  // that was right. Someone whose password came out of a generator cannot fix
  // that by reading the message.
  //
  // ioredis is the authority on everything after the scheme.
  REDIS_URL: Joi.string()
    .pattern(/^rediss?:\/\/\S+$/)
    .required()
    .messages({
      'string.pattern.base':
        'REDIS_URL debe ser una cadena de conexión que empiece con ' +
        'redis:// o rediss:// (la que te da Redis Cloud).',
    }),

  // Firebase service account (the .json file, base64-encoded in one line).
  // Required: FirebaseAuthGuard consumes it, and there is no unauthenticated
  // fallback mode. A missing or malformed value stops the process at boot.
  //
  // Used ONLY to verify ID tokens, never to manage users — accounts are
  // created by hand in the Firebase console.
  FIREBASE_SERVICE_ACCOUNT_BASE64: Joi.string().required(),

  // BOOTSTRAP, TEMPORARY. Email of the single account allowed to operate the
  // API while this project has no accounts or roles of its own. Anyone else
  // with a valid token authenticates and gets zero permissions.
  //
  // It has to be required: with no root address nobody can do anything, and a
  // silent default would be an unowned administrator account.
  //
  // TODO: delete this variable in the change that introduces the local
  // Account/Role collections and resolves identity against them.
  ROOT_ADMIN_EMAIL: Joi.string().email().required(),

  // Comma-separated list of web origins allowed to call this API, e.g.
  // "https://finanzas.ejemplo.com". Scheme and host, no path, no trailing slash.
  //
  // Required in production: an API that answers any origin lets a page the
  // caller never visited read responses on their behalf. In development it may
  // be empty, and any localhost origin is accepted instead — Vite reassigns its
  // port whenever the default is taken, and a policy that breaks on port 5174
  // gets "fixed" by opening it to everything.
  CORS_ORIGINS: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string().required(),
    otherwise: Joi.string().optional().allow(''),
  }),
});
