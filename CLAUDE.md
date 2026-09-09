# CLAUDE.md — WebSACO Finanzas · Backend

> **Read `../CLAUDE.md` first.** Those rules apply here and aren't repeated below.

Instructions for AI coding agents in this repo. Human setup docs live in `README.md`.

## What this is

REST API for WebSACO Finanzas (billing, receivables, reports). Stack: Node 22, NestJS 11, TypeScript, MongoDB/Mongoose, Redis (ioredis), Firebase Admin (token verification only), `pdf-lib`. Target: Cloud Run.

Scope so far: config, Mongo/Redis, health, Firebase auth against local accounts, the catalog/identity model (coproperties, units, parties, charge concepts, accounts/assignments), tenant context + CASL + the API contract convention, and the financial documents (facturación, recibos, notas contables/crédito/débito, PDFs, accounting ledger, estado de cuenta, cartera aging, auditoría). Queues/mailer not yet built.

## Commands

| Command | What it does |
| --- | --- |
| `npm run start:dev` | Nest watch mode, API at `http://localhost:3000/api/v1` |
| `npm run build` | SWC build — **does not typecheck** |
| `npm run typecheck` | `tsc --noEmit` — the real type gate |
| `npm run lint` | ESLint with `--fix` |
| `npm test` | Jest unit tests (`*.spec.ts`) |
| `npm run test:cov` | Coverage |
| `npm run seed:admin` | Creates the first platform-admin account from `ROOT_ADMIN_EMAIL` |

Before declaring a change done: `npm run typecheck && npm run lint && npm test` → delegate per your user-global `~/.claude/CLAUDE.md` routing rule (Test/Lint/Build Execution Routing, not this repo's `../CLAUDE.md`), do not run directly via Bash.

No Docker, no local database — Mongo (Atlas) and Redis (Redis Cloud) are managed services reached over the network. `npm run start:dev` is the whole story. Don't add `docker-compose.yml` or a `start:local-services` script back; both were removed on purpose.

## Non-negotiable rules

1. **No silent config fallbacks.** Every required env var is in `src/config/env.validation.ts` (Joi) and fails loudly at boot when missing — never `process.env.X ?? 'default'` in `app.config.ts`. New required var → new Joi rule + `.env.example` entry.
2. **Never require a secret nothing reads**, and never add one silently either — `FIREBASE_SERVICE_ACCOUNT_BASE64` boots-fails without a Joi rule, no "unauthenticated fallback".
3. **Every request input goes through a DTO.** Global `ValidationPipe`: `whitelist`, `forbidNonWhitelisted`, `transform`. An untyped body/query is a bug.
4. **Liveness never checks dependencies.** `GET /health/live` stays dependency-free so a slow Mongo/Redis triggers a readiness failure, not a restart loop. Dependency checks belong in `/health/ready`.
5. **API prefix is `api/v1`**, set once in `main.ts` — controllers never repeat it.
6. **CORS is always on** (`src/config/cors.ts`): explicit allow-list from `CORS_ORIGINS` in prod; any localhost in dev, since Vite's port moves. Adding a new client header (coproperty id, idempotency key) means updating `allowedHeaders` in the same change.
7. **Responses use the `{ statusCode, data }` envelope** the frontend unwraps in `client.ts`. Never return a bare payload.
8. **The tenant never comes from the client.** See "The tenancy law".
9. **Nothing financial is ever deleted.** See "The audit law".

## This system stands alone

Two of three sale configurations involve zero integration with the building-management system, so Finanzas must be complete alone: it owns all its data and never reads a catalog out of the other system. Where both exist, the integration is outbound-only and optional — Finanzas feeds the other system, never the reverse — enabled per coproperty (the flag is "this coproperty *also* uses the other system", not the other way round). The domain code must not know the other system exists; publishing lives at the edge, reacting to what the domain already recorded. Deleting the publishing side entirely should leave every financial module compiling, tested, and correct — that's the test for whether it's separated properly. Absence of the integration needs no fallback or warning state; for most clients it's simply not part of the product.

## The tenancy law

Every query on tenant-owned data resolves the tenant from the request context, never the payload:

```ts
const coPropertyId = this.tenant.resolveCoPropertyId();
return this.model.find({ coPropertyId }).exec();
```

- `TenantContextService.resolveCoPropertyId()` returns an **`ObjectId`**, not a string — a filter built from the string form matches nothing and silently returns an empty list, the worst failure mode (a 60-unit building reads as empty, and nobody suspects the query). Never hand-build from `activeCoPropertyIdOrNull()` (the string form, for callers that must branch on absence).
- A client-supplied `?coPropertyId=` may only ever *confirm* the active tenant, never set it.
- No fallback to "the first coproperty" when nothing is active — that's a cross-tenant leak wearing a helpful face. No active tenant → throw.
- **`findById(x)` is the recurring real bug here** — it filters only by `_id`, correct only when `_id` IS the tenant id (`copropiedades.findById(coPropertyId)`). For any other tenant-owned lookup (`Inmueble`, `Tercero`, etc.), use `findOne({ _id: x, coPropertyId })`. This exact mistake has shipped and regressed multiple times in this codebase's own history (`consultas` module) — check for it specifically on any new "fetch by id I already have" lookup.

`FirebaseAuthGuard` writes the tenant into CLS after checking the requested `X-CoProperty-Id` against the caller's live assignments via `AccesoService` — a header naming a coproperty they can't use is **rejected**, never silently ignored. Access resolves as a union (a per-building grant and a per-entity grant both reach the same place, merging where they overlap); an inactive assignment, company, or building removes access at any hop.

**Choosing a coproperty:** the list is this system's own `(accountId, coPropertyId)` pairs — local, no join needed. The listing endpoint must not itself require an active tenant (that's a deadlock: you need the list to pick one). The guard revalidates the header against live assignments on every request — a remembered choice in the client is a request, never a grant. One assignment → auto-select. Zero → say so plainly, never render an empty picker.

## The audit law

**No financial document is ever physically deleted.** Voiding is a state transition (`estado: 'anulada'`) plus an append-only log entry (who/when/why). This is enforced in the vocabulary: there is no `delete` action and no `eliminar` verb in `permission-map.ts`, so no route can be granted it. `annul` is the sanctioned replacement, kept separate from `update` so a role can hold one without the other. Don't add `delete`/`eliminar` back — `permission-map.spec.ts` fails on purpose if someone does.

## Authentication

`@UseGuards(FirebaseAuthGuard, PoliciesGuard)`, in that order (`PoliciesGuard` reads `request.user`). Health endpoints carry no guard.

The guard verifies `Authorization: Bearer <token>` with `verifyIdToken(token, true)` — `checkRevoked: true` costs one round trip but gives immediate lockout on a disabled account instead of waiting up to an hour for expiry. Don't drop it. Every verification failure returns the same opaque 401 — a probe shouldn't distinguish expired/revoked/forged; detail goes to the log.

**This project only ever verifies identities — it never creates, updates, or deletes Firebase users.** Accounts are provisioned by hand in the console; don't add `createUser`/`setCustomUserClaims`/a seed that writes to Firebase — the identity pool is shared with another system's real users.

**Two identities, not one:** the provider answers "who are you", the local `Account` answers "what may you do here". A valid token with no local account is authenticated and entitled to nothing — the guard lets it through with an empty permission list rather than rejecting, because real users of the other system can obtain valid tokens for this API and must land on nothing (not an error).

`CuentaService.resolverPorToken()` matches by provider uid, falling back to email only for first-claim of an admin-prepared account (safe: the provider allows one account per address). `email_verified` is deliberately not checked — console-created accounts start unverified with no way to change it. `ROOT_ADMIN_EMAIL` is only the input to `npm run seed:admin` (creates the first platform-admin account so someone can create others); it never touches the identity provider.

## Authorization

`@CheckAbility({ action, subject })` on the route, `PoliciesGuard` in the controller's own `@UseGuards` (never a global `APP_GUARD` — must run after auth). **Enforcement is opt-in**: an undecorated route is unchecked, which is a hole on any financial endpoint — every controller that reads/writes a document needs one.

Permission keys are Spanish `modulo.accion` strings mapped to CASL rules in exactly one place, `permission-map.ts` — new subject → add to both `SUBJECTS` and `MODULE_TO_SUBJECT`. Unknown keys are skipped, and skipping means deny. `Inmueble`/`Tercero`/`ConceptoCobro` are distinct subjects from `Consulta` on purpose — reading the arrears report doesn't imply editing who owns a unit.

**The platform-admin layer:** `EntidadAdministradora` and `Copropiedad` sit *above* CASL and the tenancy law — a coproperty IS the unit of tenancy, so there's no active-coproperty to scope its own catalog by, and no customer administrator should ever hold a permission to edit it. Gated by `PlatformAdminGuard`, not `PoliciesGuard`/`@CheckAbility`. `EntidadesService`/`CopropiedadesService` never touch `TenantContextService` for the same reason. Same audit law applies: `estado: 'inactivo'` retires an entity/coproperty without touching anything it once administered.

## The contract law

Persistence is English, the API is Spanish, a mapper is the only thing that crosses between them. Shapes go in `src/contracts/index.ts`; each module owns a `<module>.mapper.ts` of pure functions. A controller returns mapper output, never a Mongoose document.

## Layout and where new code goes

```
src/
  main.ts              bootstrap: global prefix, ValidationPipe, shutdown hooks
  app.module.ts        composition root — register every new feature module here
  config/              env.validation.ts (Joi), app.config.ts (typed, via ConfigService)
  contracts/index.ts   the Spanish API shapes — see "the contract law"
  common/              cross-cutting, @Global CommonModule
    redis/ firebase/ guards/ decorators/ tenant/ interfaces/ utils/ pdf/
  modules/
    casl/              authorization vocabulary, permission map, PoliciesGuard
    <feature>/         one folder per business domain
```

A feature module is `modules/<name>/` with `<name>.module.ts/.controller.ts/.service.ts/.mapper.ts`, `dto/`, colocated `*.spec.ts` — registered in `app.module.ts`. Mongo schemas live under `database/schemas/<feature>/`, not inside the module. Shared infra belongs in `common/`, exported by the `@Global` `CommonModule` (inject the token directly, e.g. `@Inject(REDIS_CLIENT)`).

## Code conventions

- Comments/identifiers/JSDoc: **English**. Test descriptions and end-user strings: **Spanish**.
- Every exported function/class/provider carries a JSDoc explaining *why*, not *what* — but keep it to what's non-obvious; don't restate the signature in prose.
- Prettier (single quotes, trailing commas). ESLint `recommendedTypeChecked` — don't silence a rule inline without explaining the trade-off.
- Imports are **relative**. The `@/*` alias exists in `tsconfig.json` but is **not** wired in `.swcrc` — an `@/` import typechecks then fails at runtime.
- Tests: Jest, colocated `*.spec.ts`. Controllers tested by direct instantiation with hand-rolled mocks, not `Test.createTestingModule`, unless DI wiring itself is under test.
- **DTO filenames are Spanish-verb-prefixed** (`guardar-`, `listar-`, `anular-`, `aplicar-`, `cargar-`, `importar-`, `actualizar-`, `distribucion-`, `filtros-`…), matching the action, not an English CRUD prefix like `create-`/`update-`. Follow the existing verb for the action you're adding rather than inventing a new one.

## Gotchas

- **One connection string per service** — `MONGODB_URI`, `REDIS_URL`, never host/port/password split. Joi validates the scheme (pasting the web console URL instead of the connection string is the easy mistake).
- Redis: one shared client (`common/redis/redis.provider.ts`) with an `error` listener and a capped `retryStrategy`. Don't open ad-hoc clients.
- Redis has **no consumer yet beyond its own health check** — wired ahead of BullMQ. Don't invent uses for it, don't remove it either.
- `pdf-lib` (writing PDFs) is core; `pdfjs-dist` (reading them) is deliberately absent — nothing in the domain reads PDFs.
- `npm run build` skips typechecking (`typeCheck: false`, SWC). A green build proves nothing about types — use `npm run typecheck`.

## Not here yet — do not assume it exists

BullMQ queues and the mailer (`app.module.ts` still just has comments where they'll attach). Verify against `src/modules/` and `src/database/schemas/` before assuming any other module is missing — this list drifts fast.

## Decisions pending Engram save

> Verified true in this codebase but not yet persisted via `mem_save`
> (Engram was disconnected when these were written up). A human or a future
> Engram-connected session should save each as `type: decision` and then
> delete it from here.

- **Builder: `nest-cli.json` sets `"builder": "swc"` with `"typeCheck": false`.**
  What: the default Nest/tsc build path is bypassed; `npm run typecheck`
  (`tsc --noEmit`) is the actual type gate, already called out in the
  Commands table above. Why: not documented anywhere in this repo —
  presumably faster build times in dev/CI, same as the equivalent choice in
  the sibling building-management system, but that's an inference, not a
  confirmed rationale. Where: `backend/nest-cli.json`.
- **Graceful shutdown: `app.enableShutdownHooks()` is called explicitly in
  `main.ts`.** Why: so Mongo and Redis connections close cleanly on SIGTERM
  instead of being cut mid-request — relevant on Cloud Run, which sends
  SIGTERM before killing an instance during a deploy or scale-down. Where:
  `backend/src/main.ts`.
