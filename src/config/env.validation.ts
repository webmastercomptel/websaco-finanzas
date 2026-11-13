import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  // What this process is for (see common/proceso/): `all` = HTTP + queue
  // workers + scheduled jobs (today's behaviour, the default), `api` = HTTP
  // only, `worker` = HTTP plus the queue workers and scheduled jobs. An `api`
  // process only enqueues lote jobs: it needs an `all`/`worker` process to
  // run them.
  APP_ROLE: Joi.string().valid('all', 'api', 'worker').default('all'),

  // Error reporting (see common/sentry/). Optional: without a DSN nothing is
  // reported. https only; an empty value counts as absent. main.ts reads it
  // straight from the environment because Sentry must start before Nest; this
  // rule only keeps a typo from passing silently.
  SENTRY_DSN: Joi.string()
    .uri({ scheme: ['https'] })
    .empty('')
    .optional(),

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

  // Cloud Storage bucket that holds generated documents (see
  // common/storage/). No default: a wrong-but-present bucket name fails at
  // upload time with an opaque 404, which is much harder to trace back to a
  // typo than a boot-time Joi error naming the exact variable.
  FIREBASE_STORAGE_BUCKET: Joi.string().required(),

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

  // Comptable integration ("Interfaz a Comptable", see
  // modules/interfaz-comptable/ and docs/runbooks/interfaz-comptable.md).
  // Both optional and paired with `.and()`: a URL with no secret could only
  // send requests Comptable rejects, and a secret with no URL is a secret
  // nothing reads. With neither, the screen says the integration is not
  // configured. The URL is the API base INCLUDING Comptable's `/api/v1`
  // prefix (e.g. https://comptable.ejemplo.com/api/v1) — the signed path is
  // derived from it. The secret is shared with Comptable only (a different
  // relationship that rotates on its own).
  COMPTABLE_API_URL: Joi.string()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().uri({ scheme: ['https'] }),
      otherwise: Joi.string().uri({ scheme: ['http', 'https'] }),
    })
    .optional(),
  COMPTABLE_HMAC_SECRET: Joi.string().min(32).optional(),

  // Outgoing email (SendGrid; see common/correo/ and modules/health/correo.health.ts).
  // Optional and paired with `.and()`: a key with no sender can only produce
  // sends SendGrid rejects, and a sender with no key is a setting nothing reads.
  // With neither, no email leaves the system and readiness reports the check as
  // skipped. The sender address must be a verified Sender Identity in SendGrid;
  // that cannot be checked here (no network call at boot). An empty value counts
  // as absent so a blank line in `.env` does not half-configure the pair.
  SENDGRID_API_KEY: Joi.string().empty('').optional(),
  SENDGRID_FROM_EMAIL: Joi.string().email().empty('').optional(),
  SENDGRID_FROM_NAME: Joi.string().empty('').default('WebSaco'),

  // Public address of the web app, used to build the links in emails (sign-in
  // links, "open this task", the invoice PDF link). Optional for the other
  // emails: without it those go out with no link, never with a wrong one. The
  // invoice send is stricter: `procesar-pendientes` answers 409 without a usable
  // value and `/health/ready` (frontend-url) fails when mail is configured and
  // it is missing or malformed. https is mandatory in production because the
  // link carries a credential; scheme + host only, no path, query or fragment.
  FRONTEND_URL: Joi.string()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().uri({ scheme: ['https'] }),
      otherwise: Joi.string().uri({ scheme: ['http', 'https'] }),
    })
    .empty('')
    .optional(),

  // How many reverse proxies sit between the client and this process; Express
  // derives `req.ip` by trusting exactly that many hops of X-Forwarded-For,
  // counted from the right (the entries proxies append), so a value the client
  // wrote itself is never taken. 1 = Cloud Run behind Google's front end (the
  // target). 2 = an external HTTPS load balancer in front of Cloud Run. 0 =
  // exposed directly (X-Forwarded-For ignored). Too LOW is safe (every client
  // reads as the proxy, so per-address limits become shared); too HIGH lets a
  // client pick its own address. Never `true`: that trusts the left-most,
  // client-controlled entry. Used by the access-link redeem's per-IP limit.
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(3).default(1),

  // Integrations panel (see modules/integraciones-panel/ and
  // docs/runbooks/integracion-panel.md). The switch is OFF by default: a
  // deployment that never heard of the panel behaves exactly as before. With
  // the switch on, the secret is mandatory — a module that answers with no way
  // to authenticate its caller would be a hole, so boot fails naming it. The
  // secret is shared with the panel and the other systems and must be
  // DIFFERENT from COMPTABLE_HMAC_SECRET (it rotates on its own). An empty value counts as absent.
  INTEGRACION_PANEL_HABILITADA: Joi.boolean().default(false),
  PANEL_HMAC_SECRET: Joi.string()
    .min(32)
    .empty('')
    .invalid(Joi.ref('COMPTABLE_HMAC_SECRET'))
    .when('INTEGRACION_PANEL_HABILITADA', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
})
  .and('COMPTABLE_API_URL', 'COMPTABLE_HMAC_SECRET')
  .and('SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL');
