# AGENTS.md — WebSACO Finanzas · Backend

> **Before any task, read `../AGENTS.md` first.** Those rules apply here and are
> deliberately not repeated in this file. Some tools load only the closest
> instruction file and silently ignore the parent one — if you have not read it
> this session, read it now.

Instructions for AI coding agents working in this repository. Read this before
touching any file. Human-facing setup docs live in `README.md`.

## What this is

REST API for WebSACO Finanzas (financial panel for copropiedades: billing,
receivables, reports). A standalone project: the conventions that apply are the
ones written here, not inherited from any other codebase. Stack: Node 22,
NestJS 11, TypeScript, MongoDB/Mongoose, Redis (ioredis), Firebase Admin
(token verification only), `pdf-lib`. Target runtime: Cloud Run.

Scope so far: configuration, Mongo/Redis connections, health, Firebase
authentication resolved against local accounts, the catalog and identity model
(coproperties, units, parties, charge concepts, accounts and assignments), and
the authorization layer — tenant context, CASL, the API contract convention.
The financial documents are not built yet: they are a double-entry ledger and
they wait on domain answers. Queues and mailer land later.

## Commands

| Command | What it does |
| --- | --- |
| `npm run start:dev` | Nest in watch mode, API at `http://localhost:3000/api/v1` |
| `npm run build` | SWC build — **does not typecheck** |
| `npm run typecheck` | `tsc --noEmit` — the real type gate, run it separately |
| `npm run lint` | ESLint with `--fix` |
| `npm test` | Jest unit tests (`*.spec.ts`) |
| `npm run test:cov` | Coverage |
| `npm run seed:admin` | Creates the first platform-admin account from `ROOT_ADMIN_EMAIL` |

Before declaring any change done: `npm run typecheck && npm run lint && npm test`.

There is **no Docker and no local database**. Mongo (Atlas) and Redis (Redis
Cloud) are managed services reached over the network, so `npm run start:dev` is
the whole story: plain Node, a `.env` with connection strings, nothing to
install or start first. Do not add a `docker-compose.yml` or a
`start:local-services` script back — both existed and were removed on purpose,
because an agent that suggests them on a machine without Docker sends the
operator down a dead end.

## Non-negotiable rules

1. **No silent fallbacks for configuration.** Every required env var is
   declared in `src/config/env.validation.ts` (Joi) and must fail loudly at
   boot when missing. Never write `process.env.X ?? 'default'` in
   `src/config/app.config.ts` — the `!` non-null assertions there are valid
   *only* because Joi already guaranteed the value. A new required var means a
   new Joi rule plus a documented entry in `.env.example`.
2. **Never demand a secret no code reads.** The flip side now applies too:
   `FIREBASE_SERVICE_ACCOUNT_BASE64` is required because `FirebaseAuthGuard`
   consumes it, and a missing or malformed credential stops the process at
   boot. There is no "unauthenticated fallback mode".
3. **Every request input goes through a DTO.** The global `ValidationPipe` runs
   with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`
   (`src/main.ts`). An untyped body or query param is a bug, not a shortcut.
4. **Liveness never checks dependencies.** `GET /api/v1/health/live` must stay
   dependency-free — a slow Mongo/Redis should drop the pod from readiness, not
   trigger a restart loop. Dependency checks go in `/health/ready` (and the
   default `/health`), via Terminus indicators.
5. **The API prefix is `api/v1`**, set globally in `main.ts`. Controllers never
   repeat it in their `@Controller()` path. The browser app's `VITE_API_URL`
   must therefore include it — a base URL without `/api/v1` 404s every call.
6. **The browser app is always cross-origin**, so CORS is not optional.
   `src/config/cors.ts` holds the policy: an explicit allow-list from
   `CORS_ORIGINS`, required in production; in development any localhost origin
   is accepted, because Vite reassigns its port and a policy that breaks on
   5174 gets "fixed" by opening it to everything. A new client header (the
   coproperty, an idempotency key) must be added to `allowedHeaders` in the
   same change, or the preflight fails without saying which header was wrong.
7. **Responses use the `{ statusCode, data }` envelope** the frontend unwraps
   in `src/lib/api/client.ts`. Do not return bare payloads from new endpoints.
8. **The tenant never comes from the client.** See below — this is the rule
   broken most easily and with the worst consequences.
9. **Nothing financial is ever deleted.** See below.

## This system stands alone

WebSACO Finanzas is a product sold on its own. A client may buy Finanzas only,
Finanzas together with the building-management system, or that system only — so
**in two of the three configurations there is no integration at all**, and
Finanzas must be complete without one.

The consequences are structural, not stylistic:

- **Finanzas owns all of its data**, including coproperties, units and the
  people attached to them. It never reads a catalog out of another system, and
  it must never require one to be present. If a feature cannot work for a
  client who owns nothing but this, it is designed wrong.
- **The integration is outbound and optional.** Where both products exist,
  Finanzas is the source of truth and *feeds* the other system. Nothing flows
  the other way.
- **Enabled per coproperty.** Every coproperty in this database has Finanzas by
  definition, so the flag that matters is "this coproperty *also* uses the
  building-management system". Easy to state backwards; do not.
- **The domain does not know the other system exists.** Publishing lives at the
  edge — a separate outbound concern reacting to what the domain recorded, never
  a call inside a service that creates an invoice. Delete the whole publishing
  side and the financial modules must still compile, still pass their tests, and
  still be correct. That is the test for whether it is properly separated, and
  it is worth applying literally when reviewing a change.
- Absence of the integration is not a degraded mode, a cache miss, or an
  outage. For most clients it is simply not part of the product, so it needs no
  fallback, no warning banner and no "unavailable" state.

## The tenancy law

Every query that touches tenant-owned data starts by resolving the tenant from
the request context, never from the payload:

```ts
const coPropertyId = this.tenant.resolveCoPropertyId();
const query: Record<string, unknown> = { coPropertyId };
return this.model.find(query).exec();
```

- `TenantContextService.resolveCoPropertyId()` reads the active coproperty from
  CLS, where it is written per request *after* the caller's assignment has been
  checked. It returns a plain `string` today; whether the stored field becomes
  an ObjectId reference is settled with the schemas.
- A client-supplied id (`?coPropertyId=`) may be passed as the argument, and it
  is only ever accepted when it matches the active tenant exactly. It can
  confirm the tenant; it can never set it.
- With no active tenant the call throws. There is deliberately **no** fallback
  to "the first coproperty", not even once the collection exists: a default
  tenant is a cross-tenant leak wearing a helpful face, turning a request that
  should have failed into one that quietly returns someone else's money.
- A `find` / `findOne` / `updateOne` on a financial collection without
  `coPropertyId` in the filter is a bug, even when it looks like it works.

`FirebaseAuthGuard` is what writes the tenant into CLS, and only after checking
the requested `X-CoProperty-Id` against the caller's live assignments through
`AccesoService`. A header naming a coproperty they may not use is **rejected**,
never ignored — silently serving a different tenant's data because the
requested one was not allowed is the worst available answer.

Access resolves as a **union**, not a lookup: a grant on one building and a
grant on the company that administers it both reach the same place, and where
they overlap the permissions merge. Inactive filters at every hop — a suspended
assignment, a suspended company or a deactivated building each remove access on
their own.

### Choosing a coproperty

A person may be assigned more than one coproperty, so the app asks which one to
work on before anything tenant-scoped happens. Rules for building that:

- **The list is this system's own `(accountId, coPropertyId)` pairs**, and so
  are the coproperty names shown next to them. Everything the picker needs is
  local.
- **The endpoint that returns the list must not require an active tenant.**
  It is what lets the caller pick one — requiring a tenant to obtain the list
  of tenants is a deadlock. This works today because the guard never demands a
  tenant; only `TenantContextService` does, and only when a query needs one.
  Keep it that way: never make the guard reject a request merely for lacking
  `X-CoProperty-Id`.
- **The guard validates the header against the caller's assignments on every
  request.** Without that check the picker is decoration — anyone can send any
  id. A remembered choice on the client (localStorage, a URL, a stale tab) is a
  *request*, never a grant, and an assignment revoked five minutes ago must stop
  working now.
- One assignment: select it, do not ask. Zero: say so plainly. An empty picker
  or a one-option question is friction, not a choice.

## The audit law

**No financial document is ever physically deleted.** Voiding is a state
transition (`estado: 'anulada'`) plus an append-only log entry recording who,
when and why.

This is enforced in the vocabulary, not just in prose: there is no `delete`
action in `src/modules/casl/casl-ability.constants.ts` and no `eliminar` verb in
`permission-map.ts`, so no route can be granted the permission in the first
place. `annul` is the sanctioned replacement, kept separate from `update`
because voiding is the most consequential act in this domain and a role must be
able to hold one without the other.

Do not add `delete`/`eliminar` back. `permission-map.spec.ts` fails on purpose
if someone does.

## Authentication

`@UseGuards(FirebaseAuthGuard, PoliciesGuard)` on the controller, in that
order — `PoliciesGuard` reads `request.user`, so it cannot run first. Health
endpoints carry no guard and stay public.

The guard verifies the `Authorization: Bearer <firebase-id-token>` header with
`verifyIdToken(token, true)`. That `true` is `checkRevoked`: it costs one round
trip per request and buys immediate lockout when an account is disabled, instead
of waiting up to an hour for the token to expire. Do not drop it to save a call.

Every verification failure returns the same opaque 401. A probe must not be able
to tell an expired token from a revoked one from a forged one — the detail goes
to the log, where it is useful and not exploitable.

**This project only ever VERIFIES identities. It never creates, updates or
deletes users.** Accounts are provisioned by hand in the Firebase console. Do
not add `createUser`, `setCustomUserClaims`, or a seed that writes to Firebase:
the identity pool is shared with another system, and writing into it from here
reaches that system's real users.

**Two identities, and they are not the same thing.** The provider answers "is
this person who they claim to be"; the local `Account` answers "and what may
they do here". A valid token with no local account is authenticated and
entitled to nothing — and that is a state the app must be able to render, so
the guard lets the request through with an empty permission list rather than
rejecting it. "Authenticated but powerless" matters here precisely because the
identity pool is shared: real users of the other system can obtain valid tokens
for this API and must land on nothing.

`CuentaService.resolverPorToken()` finds the account by provider uid, and only
failing that by email — which is how an account an administrator prepared in
advance gets claimed the first time that person signs in, binding the uid from
then on. The email fallback is safe because the provider allows one account per
address, so nobody can obtain a token for an address that is already someone
else's.

`email_verified` is deliberately not consulted. Accounts are created by hand in
the Firebase console, where they start unverified and the console gives no way
to change it, so requiring it locked out the only account meant to get in.

`ROOT_ADMIN_EMAIL` is no longer an authorization rule. It is the input to
`npm run seed:admin`, which creates the first platform-admin account —
otherwise nobody can sign in to create anyone, since accounts are made through
the API and the API grants nothing without one. That seed never touches the
identity provider; the person is still created by hand in the console.

## Authorization

`@CheckAbility({ action, subject })` on the route, `PoliciesGuard` in the
controller's `@UseGuards` (never as a global `APP_GUARD` — it reads
`request.user` and must run after the auth guard).

Enforcement is **opt-in**: a route with no decorator is not checked at all. On a
financial endpoint that is a hole, so every controller that reads or writes a
document carries one.

Permission keys are Spanish `modulo.accion` strings (`facturas.anular`) mapped
to CASL rules in exactly one place, `src/modules/casl/permission-map.ts`. Adding
a subject means adding it to `SUBJECTS` *and* to `MODULE_TO_SUBJECT`. Unknown
keys are skipped, and skipping means deny.

## The contract law

Persistence is English, the API is Spanish, and a mapper is the only thing that
crosses between them. Shapes go in `src/contracts/index.ts`; each module owns a
`<module>.mapper.ts` of pure functions. A controller returns mapper output,
never a Mongoose document — leaking a document leaks the persistence model and
welds the frontend to it.

## Layout and where new code goes

```
src/
  main.ts              bootstrap: global prefix, ValidationPipe, shutdown hooks
  app.module.ts        composition root — register every new feature module here
  config/
    env.validation.ts  Joi schema — the single gate for env vars
    app.config.ts      typed config namespace ('app.*'), read via ConfigService
  contracts/index.ts   the Spanish API shapes — see "the contract law"
  common/              cross-cutting, @Global CommonModule
    redis/             shared ioredis client, exported via the REDIS_CLIENT token
    firebase/          Firebase Auth instance — verification only, never writes
    guards/            FirebaseAuthGuard — see "authentication"
    decorators/        CurrentUser
    tenant/            CLS-backed tenant context — see "the tenancy law"
    interfaces/        IRequestUser: the shape the auth guard must produce
    utils/             mapper helpers (toIso, idToString) — pure and total
    pdf/               pdf-lib helpers (invoices, receipts, credit notes)
  modules/
    casl/              authorization vocabulary, permission map, PoliciesGuard
    <feature>/         one folder per business domain
```

A feature module is `modules/<name>/` with `<name>.module.ts`,
`<name>.controller.ts`, `<name>.service.ts`, `<name>.mapper.ts`, `dto/`, and
colocated `*.spec.ts`. Register it in `app.module.ts`. Mongo schemas live under
`database/schemas/<feature>/`, not inside the feature module.

Shared infrastructure providers belong in `common/` and are exported by
`CommonModule` (it is `@Global`, so feature modules do not re-import it — they
inject the token directly, e.g. `@Inject(REDIS_CLIENT)`).

## Code conventions

- Comments, identifiers, JSDoc: **English**. Test descriptions (`it('...')`) and
  end-user-facing strings: **Spanish**, matching the existing specs.
- Every exported function, class, and provider carries a JSDoc block explaining
  *why*, not just *what*. Existing files set the bar — match their density.
- Prettier: single quotes, trailing commas (`.prettierrc`). ESLint runs
  `recommendedTypeChecked`; do not silence a rule inline without a comment
  explaining the trade-off.
- Imports are **relative** (`./`, `../`). The `@/*` alias exists in
  `tsconfig.json` but is **not** configured in `.swcrc`, so an `@/` import
  typechecks and then fails at runtime. Either keep using relative paths or fix
  `.swcrc` first — never half of it.
- Tests are Jest, colocated next to the code as `*.spec.ts` (`rootDir: src`).
  Controllers are tested by direct instantiation with hand-rolled mocks (see
  `health.controller.spec.ts`), not with a full `Test.createTestingModule`
  unless the DI wiring is what is under test. `tenant-dev-header.middleware.spec.ts`
  is the one place that earns the exception: it boots a real HTTP app because
  middleware mounting and route matching are exactly what it verifies.
- Test descriptions are in Spanish; everything else in the file is English.

## Gotchas

- **One connection string per service**, never host/port/password split across
  variables: `MONGODB_URI` and `REDIS_URL`. That is the shape both providers
  hand you, and it carries credentials and TLS along with it — enabling TLS or
  moving provider changes one value and nothing else. Joi validates the scheme
  and says what was expected, because pasting the web console's URL instead of
  the connection string is the easiest mistake to make here.
- Redis: one shared connection, created in `common/redis/redis.provider.ts`
  from `REDIS_URL`, with an `error` listener attached so a blip cannot crash
  the process with an unhandled event, and a capped `retryStrategy` because a
  managed instance drops idle connections as a matter of course. Do not open
  ad-hoc clients.
- Redis currently has **no consumer other than its own health check**. It is
  wired up ahead of BullMQ (reconciliation, notifications, and publishing to
  the building-management system where a coproperty uses both products). Do
  not invent uses for it to justify it, and do not remove it either.
- `pdf-lib` is a core domain dependency (generating invoices, cash receipts,
  credit notes) and works under the plain Jest runner — no
  `--experimental-vm-modules` needed. `pdfjs-dist` (PDF *text extraction*) is
  deliberately **not** part of this project — nothing in the domain reads PDFs,
  only writes them. Do not add it.
- `npm run build` skips type checking (`typeCheck: false` in `nest-cli.json`,
  SWC builder). A green build proves nothing about types.

## Not here yet — do not assume it exists

Local Account/Role/Membership collections (identity is still the single
`ROOT_ADMIN_EMAIL` shortcut), BullMQ queues, the mailer, the Mongo schemas for
the financial documents, and every business module. Design each one here against
the rules above, and update this file in the same change.
