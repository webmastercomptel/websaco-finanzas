# Design: Publish invoice batches to WebSaco3

## Technical Approach

This follows the approach the proposal fixed: the domain emits one event, and an edge module persists an outbox row and delivers it with an HMAC-signed `fetch`. A periodic sweep claims rows atomically and retries them. The sweep is triggered from outside the process: Google Cloud Scheduler calls an internal, shared-secret-protected HTTP endpoint, so Cloud Run can keep scaling to zero and needs no always-on CPU. The design fills in exact shapes, and it stays inside both specs (`invoice-batch-publication`, `building-management-activation`). Spec gaps are resolved below and marked **[spec-gap]**.

The event type lives in `common/`, so `facturacion` never imports the publisher. Delete `modules/publicacion-facturas/`, drop its import from `app.module.ts`, and everything still compiles. `emitAsync` with no listener resolves to `[]`.

## Architecture Decisions

| # | Topic | Choice | Rejected | Why |
|---|---|---|---|---|
| 1 | Event location | `src/common/eventos/lote-facturas-pdf-confirmado.event.ts` | Defined in the publisher module | Otherwise `facturacion` imports the publisher, which breaks the deletion test |
| 2 | Emit mode | `await this.eventos.emitAsync(...)`. The listener catches every error itself | Fire-and-forget `emit` | Awaiting means the outbox row exists before the 200 goes out, with no crash window. The listener swallows its own errors, so publishing can never fail the confirm request |
| 3 | Payload snapshot | `taxId`, `invoiceNumbers` and `objectPath` are frozen on the row when it is enqueued. Only the URL is fresh on each attempt | Re-read on every send | Retries stay deterministic. The `presentacion_documento` row for FV is write-once (`presentacion-documento.service.ts:56-60,108-112`), so `objectPath` cannot change |
| 4 | Retry transport | Outbox sweep plus atomic claim, run on each call to an internal HTTP endpoint | BullMQ delayed jobs (already wired, `app.module.ts:64-69`) | This was fixed by the proposal. The outbox row is itself the durable record, and a queue would duplicate it |
| 4b | Sweep trigger | External Cloud Scheduler job → `POST /api/v1/interno/publicacion-facturas/procesar-pendientes` | In-process `@nestjs/schedule` `@Cron` | Cloud Run throttles CPU between requests by default, so an in-process timer may never fire unless the service pays for `min-instances ≥ 1` plus `--no-cpu-throttling` around the clock. Invoice batches arrive in bursts, so paying for idle compute 24/7 is waste. Scheduler work runs *inside* a request, where CPU is always allocated. Using a managed trigger also matches the project's existing choice of managed services (Atlas, Redis Cloud, Firebase) |
| 4c | Trigger auth | A static shared secret in the `X-Scheduler-Secret` header, compared in constant time by a module-local guard | Reusing the per-request HMAC (timestamp + body) used toward WebSaco3; Cloud Run IAM / OIDC now | Cloud Scheduler sends **static** headers, so it cannot compute a per-request timestamped HMAC. A replayed call only re-runs an idempotent sweep, so replay protection buys nothing. Cloud Run IAM is **per service, not per route**, and this service must stay publicly invocable for the browser frontend. OIDC therefore means either in-app ID-token verification or a separate service. Both are larger than this change, and the codebase has no service-to-service auth pattern yet to reuse |
| 5 | Schema registration | Add to the `models` array in `database.module.ts:157-214` | `forFeature` inside the publisher module | That file's docblock (`:216-227`) says every schema is registered once, globally. A leftover inert model after rollback does no harm |
| 6 | Outbound contract type | `publicacion-facturas.contrato.ts` inside the module | `src/contracts/index.ts` | `contracts/` holds this API's shapes. This is another system's inbound shape, and it should be deleted along with the module |
| 7 | Missing config | The listener still enqueues. The sweep is a no-op when the URL or HMAC secret is absent, and the trigger endpoint fails closed (401) when its secret is absent | Skipping the enqueue | The flag is the domain truth and the config is only transport. Rows drain once configured. Per the root CLAUDE.md, absence needs no warning state |

## Data Flow

```
LotesController.confirmarGeneracionFacturas
  generacion.confirmar(...) ─ok─> facturasLean (already fetched, :376)
  └─ await emitAsync(LOTE_FACTURAS_PDF_CONFIRMADO, evt)
        └─ PublicacionFacturasListener.manejar ─> service.encolar(evt)
              Copropiedad.findById(coPropertyId)   // _id IS the tenant id: allowed
              flag off / no taxId → return
              updateOne({loteId}, {$setOnInsert: row}, {upsert})  // status 'pendiente'
Cloud Scheduler (every minute, header X-Scheduler-Secret)
  └─ POST /api/v1/interno/publicacion-facturas/procesar-pendientes
        SecretoProgramadorGuard (constant-time compare) ─fail─> 401
        PublicacionFacturasController.procesarPendientes
          └─ await service.procesarPendientes()   // awaited to completion BEFORE responding
                sweep() → loop ≤25 and within PRESUPUESTO_CICLO_MS:
                          reclamar() → procesar(row) → liberar(row, outcome)
          └─ 200 { statusCode, data: ResumenCiclo }
     procesar: generarUrlLectura → construirPayload → JSON.stringify ONCE
               → firmar → fetch POST (15s timeout) → clasificarRespuesta
```

## State Machine

`status ∈ pendiente | enviando | enviado | fallido`, plus `retryable: boolean`. Following the spec's vocabulary, **terminal fallido** means `status:'fallido', retryable:false`.

```
pendiente ──claim──> enviando ──2xx/409──────────────> enviado (final)
fallido(retryable, nextAttemptAt<=now) ──claim──^  │
                                                   ├─retry & attempts<max─> fallido(retryable:true, nextAttemptAt=now+backoff)
                                                   ├─retry & attempts>=max─> fallido(retryable:false)
                                                   └─terminal code────────> fallido(retryable:false)
enviando (claimedAt older than CLAIM_TTL) ──re-claim──> enviando   (crash recovery; attempts keeps counting)
```

The counter `attempts` is incremented **at claim time**. That makes a crash loop still reach `max`.

**Claim** (`reclamar(max)`) is one atomic operation:

```ts
const ahora = new Date();
const vencido = new Date(ahora.getTime() - CLAIM_TTL_MS);
this.model.findOneAndUpdate(
  {
    attempts: { $lt: max },
    $or: [
      { status: { $in: ['pendiente', 'fallido'] }, retryable: true, nextAttemptAt: { $lte: ahora } },
      { status: 'enviando', claimedAt: { $lte: vencido } },
    ],
  },
  { $set: { status: 'enviando', claimedAt: ahora, claimToken: randomUUID() }, $inc: { attempts: 1 } },
  { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
).lean().exec();
```

**Release** (`liberar`) is conditional on the token: `updateOne({ _id, claimToken }, { $set: { ...outcome, claimedAt: null, claimToken: null } })`. With `modifiedCount === 0`, the claim was lost to a stale re-claim, so it logs a warning and writes nothing.

**Sweep** (`barrerAgotados(max)`, run at the start of each triggered cycle):
- `updateMany({ status:'enviando', claimedAt:{$lte:vencido}, attempts:{$gte:max} }, {$set:{status:'fallido', retryable:false, claimedAt:null, claimToken:null, lastError:'reclamo-expirado'}})`
- `updateMany({ status:{$in:['pendiente','fallido']}, retryable:true, attempts:{$gte:max} }, {$set:{status:'fallido', retryable:false}})`. This covers the case where `max` is lowered through env.

**Same-instance overlap**: a `private enEjecucion = false` flag guards `procesarPendientes`. An overlapping call returns immediately with `omitido: true`. Cross-instance overlap (two Scheduler calls landing on different instances) is already safe through the atomic claim.

**Cycle time budget** (this is the only addition to the loop, and it exists because of the trigger change): the loop stops claiming new rows once `elapsed + FETCH_TIMEOUT_MS + margin > PRESUPUESTO_CICLO_MS`. Worst case is 25 rows × 15 s = 6¼ min, which would exceed both Cloud Run's default request timeout (300 s) and Cloud Scheduler's default HTTP attempt deadline (180 s). Rows left over go to the next cycle. The budget has to stay below both, and below `CLAIM_TTL_MS`, so a cycle never outlives its own claims.

**Terminal fallido has no un-stick path in this change. It is out of scope.** Recovery means a manual DB edit: `{$set:{status:'fallido', retryable:true, attempts:0, nextAttemptAt:new Date()}}`. There is no endpoint, as the proposal decided.

## Policy (pure, `publicacion-facturas.politica.ts`)

```ts
export const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000] as const; // 1m,5m,15m,1h; beyond → last
export const CLAIM_TTL_MS = 5 * 60_000;      // > fetch timeout + URL signing
export const FETCH_TIMEOUT_MS = 15_000;
export const URL_LECTURA_TTL_MS = 60 * 60_000; // receiver may download async (202)
export const LOTE_MAXIMO_POR_CICLO = 25;
export const PRESUPUESTO_CICLO_MS = 120_000;  // < Scheduler deadline (180s default) < Cloud Run timeout (300s) < CLAIM_TTL_MS
export function retrasoTras(attempts: number): number { return BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]; }
export type Clasificacion = 'enviado' | 'reintentar' | 'terminal';
export function clasificarRespuesta(status: number): Clasificacion;
```

`clasificarRespuesta` mapping:
- 200-299 and 409 → `enviado`
- 422, 429, 500-599 (which includes 502) → `reintentar`
- 401, 403 → `terminal`
- any other 4xx (400, 404, 413 ...) → `terminal` **[spec-gap: the spec lists only 201/202/409/422/502/401/403]**

A network error, a timeout, or a failure of `generarUrlLectura` → `reintentar`, with `lastStatusCode: null`.

`WEBSACO3_PUBLICACION_MAX_INTENTOS` (default 6) counts **total attempts including the first**. With 6 attempts, the last one lands about 2h21m after the first.

## Interfaces / Contracts

**Event** (`common/eventos/lote-facturas-pdf-confirmado.event.ts`):
```ts
export const LOTE_FACTURAS_PDF_CONFIRMADO = 'lote-facturas.pdf-confirmado';
export interface LoteFacturasPdfConfirmadoEvent {
  coPropertyId: string; loteId: string; objectPath: string;
  numerosFactura: string[]; // Factura.fullNumber, in findAllRawPorLote order (unitCode asc) = PDF page order
}
```

The array order is load-bearing: WebSaco3's splitter maps page i to `facturas[i]`. Anuladas are not filtered out, which mirrors exactly what went into the PDF (`lotes.controller.ts:306,323`).

**Controller change** (`lotes.controller.ts`): inject `private readonly eventos: EventEmitter2` as the last constructor parameter (`:66-76`). Insert the emit directly after `:376`, before the snapshot block, so a snapshot failure cannot suppress it:

```ts
await this.eventos.emitAsync(LOTE_FACTURAS_PDF_CONFIRMADO, {
  coPropertyId: coPropertyId.toString(), loteId: lote._id.toString(),
  objectPath: resultado.objectPath, numerosFactura: facturasLean.map((f) => f.fullNumber),
} satisfies LoteFacturasPdfConfirmadoEvent);
```

**Schema** (`database/schemas/publicaciones/publicacion-lote.schema.ts`, `@Schema({ timestamps: true, collection: 'publicaciones_lote' })`):

| Field | Type | Notes |
|---|---|---|
| `coPropertyId` | ObjectId ref Copropiedad, required | |
| `loteId` | ObjectId ref LoteFacturacion, required | Unique index `unico_publicacion_por_lote` |
| `taxId` | string, required | Snapshot taken at enqueue. Without the DV (schema convention, `copropiedad.schema.ts:27-33`) |
| `invoiceNumbers` | [string], required | Snapshot, ordered |
| `objectPath` | string, required | |
| `status` | enum `pendiente\|enviando\|enviado\|fallido`, default `pendiente` | |
| `retryable` | boolean, default true | |
| `attempts` | number, default 0 | |
| `nextAttemptAt` | Date \| null | Null once final |
| `claimedAt` | Date \| null | |
| `claimToken` | string \| null | |
| `lastStatusCode` | number \| null | |
| `lastError` | string \| null | Short code only (`HTTP 422`, `timeout`, `url-firmada`). **Never a URL or a response body** |
| `sentAt` | Date \| null | |

Indexes: `{loteId:1}` unique; `{status:1, retryable:1, nextAttemptAt:1}` named `escaneo_reintentos`; `{status:1, claimedAt:1}` named `reclamos_vencidos`.

`encolar` uses `$setOnInsert` with upsert, the same upsert idiom as `numeracion.service.ts:305-315`. If two concurrent upserts race, the loser raises E11000 (`code === 11000`), which is caught and treated as a no-op.

**Outbound payload** (`publicacion-facturas.contrato.ts`, built by `construirPayload(fila, url, expiresAt)` in `publicacion-facturas.mapper.ts`):
```ts
{ nit: string; loteId: string; facturas: { numeroFactura: string }[]; urlSigned: string; urlExpiresAt: string /* ISO-8601 */ }
```

**HMAC** (`publicacion-facturas.firma.ts`):
```ts
export function firmar(secret: string, timestamp: string, rawBody: string): string // createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
```
- `timestamp` is Unix **seconds** as a decimal string, generated per attempt.
- Headers: `Content-Type: application/json`, `X-Websaco-Timestamp: <ts>`, `X-Websaco-Signature: sha256=<hex>`.
- `rawBody = JSON.stringify(payload)` is computed **once**. That exact string is both signed and passed as `fetch`'s `body`.
- **Cross-repo contract (must go to WebSaco3):** the receiver MUST verify the HMAC over the **raw request bytes, before JSON parsing** (NestJS `NestFactory.create(..., { rawBody: true })` and `req.rawBody`, or `express.json({ verify })`). It must NOT re-serialize the parsed object: whitespace, key order or unicode escaping would differ and every signature would fail silently. Because verification uses the raw bytes, key order never matters. The receiver must also:
  - compare with `timingSafeEqual`
  - reject when `|now − ts| > 300 s`
  - treat `loteId` as the idempotency key and return 409 on a repeat. A stale re-claim can deliver the same batch twice.

**Module wiring** (`publicacion-facturas.module.ts`): `@Module({ controllers: [PublicacionFacturasController], providers: [PublicacionFacturasService, PublicacionFacturasListener, SecretoProgramadorGuard] })`, with no imports. This is the same shape as `HealthModule` (`health.module.ts:7-12`):
- the model is global via `DatabaseModule`
- `DocumentoStorageService` is global via `CommonModule` (`common.module.ts:62,81`)
- `ConfigService` is global (`app.module.ts:53-57`)

The listener uses `@OnEvent(LOTE_FACTURAS_PDF_CONFIRMADO, { async: true, promisify: true })`.

**Trigger controller** (`publicacion-facturas.controller.ts`). This follows `HealthController` (`health.controller.ts:10-11`): a plain `@Controller` with no `FirebaseAuthGuard`, no `PoliciesGuard`, and no `@CheckAbility`. There is no global `APP_GUARD` (`app-setup.ts` registers only the `TransformInterceptor`), so leaving those out is enough to exempt it from auth and CASL. It is machine-to-machine and has no user and no tenant, so CASL and the tenancy law do not apply. Its only guard is its own:

```ts
@Controller('interno/publicacion-facturas')
@UseGuards(SecretoProgramadorGuard)
export class PublicacionFacturasController {
  @Post('procesar-pendientes') @HttpCode(200)
  procesarPendientes(): Promise<ResumenCiclo>; // awaits service.procesarPendientes()
}
// ResumenCiclo = { omitido: boolean; reclamadas: number; enviadas: number; reintentar: number; terminales: number }
```
- It reads no body, query or params, so no DTO is needed (rule 3 covers inputs, and there are none). Cloud Scheduler sends an empty body.
- It **awaits the whole cycle before responding**. Cloud Run only guarantees CPU while a request is in flight, so fire-and-forget would recreate the throttling problem.
- It always returns 200 once auth passes, including for row-level failures, `omitido`, and the unconfigured no-op. Row outcomes live in the outbox. A non-2xx would only make Cloud Scheduler retry a sweep that has nothing new to do. An unexpected exception (for example, Mongo down) still returns a 500, which is correct to surface in Scheduler's logs.
- The response goes through the global `{ statusCode, data }` envelope like every other controller. `ResumenCiclo` lives in `publicacion-facturas.contrato.ts` and not in `src/contracts/`, per decision 6.
- `X-Scheduler-Secret` is **not** added to CORS `allowedHeaders`. Cloud Scheduler is not a browser, and rule 6 only covers client headers.

**`SecretoProgramadorGuard`** (`publicacion-facturas.guard.ts`, `CanActivate`):
1. Read `websaco3PublicacionTriggerSecret` from config. If it is absent, throw `UnauthorizedException`. The guard **fails closed** and is never open because config is missing.
2. Read `request.headers['x-scheduler-secret']`. If it is missing or not a string, throw `UnauthorizedException`.
3. Compare `timingSafeEqual(sha256(provided), sha256(expected))`. Hashing first equalizes the lengths, so `timingSafeEqual` cannot throw, and the secret's length does not leak.
4. Every failure returns the same opaque 401, the same policy as `FirebaseAuthGuard`, and the reason goes only to the log. The header value is never logged.

The guard lives inside the module so that deleting the module removes it too. If a second scheduled job ever appears, promote it to `common/guards/` then.

**Infra note (out of this repo's code):** once a separate trigger service or in-app ID-token verification exists, Cloud Scheduler can call the endpoint with an OIDC identity token (`--oidc-service-account-email`, audience = service URL) instead of the shared header. Until then, the shared-secret header is the whole mechanism.

**`app.module.ts`:**
- Add `EventEmitterModule.forRoot()` directly after `BullModule.forRootAsync` (`:64-69`). There is no `ScheduleModule`.
- Add `PublicacionFacturasModule` last in `imports` (after `:94`).
- `EventEmitterModule` stays even on rollback, because `LotesController` injects `EventEmitter2`.

**Config:**

`env.validation.ts` gets these new keys inside the `Joi.object` (`:3-92`), and the object is chained with `.and('WEBSACO3_FACTURAS_ENDPOINT_URL', 'WEBSACO3_HMAC_SECRET', 'WEBSACO3_PUBLICACION_TRIGGER_SECRET')` (all-or-none). The listener only enqueues and every send happens in a triggered cycle, so a URL and HMAC secret without a trigger secret would mean rows that never drain. Boot fails loudly instead:
```ts
WEBSACO3_FACTURAS_ENDPOINT_URL: Joi.string().when('NODE_ENV', { is: 'production',
  then: Joi.string().uri({ scheme: ['https'] }), otherwise: Joi.string().uri({ scheme: ['http', 'https'] }) }).optional(),
WEBSACO3_HMAC_SECRET: Joi.string().min(32).optional(),
WEBSACO3_PUBLICACION_TRIGGER_SECRET: Joi.string().min(32).optional(), // shared with the Cloud Scheduler job header; must differ from WEBSACO3_HMAC_SECRET
WEBSACO3_PUBLICACION_MAX_INTENTOS: Joi.number().integer().min(1).max(20).default(6),
```

The trigger secret is a separate value from `WEBSACO3_HMAC_SECRET`. It is shared with a different party (the Cloud Scheduler job config rather than WebSaco3), so one can be rotated or leaked without the other. Rule 2 holds: the guard reads it.

`app.config.ts` follows the `PORT`/`corsOrigins` precedent (`:14,22`) with no `??`:
- `websaco3FacturasEndpointUrl`
- `websaco3HmacSecret`
- `websaco3PublicacionTriggerSecret`
- `websaco3PublicacionMaxIntentos: parseInt(process.env.WEBSACO3_PUBLICACION_MAX_INTENTOS!, 10)`

Add all four to `.env.example`, commented out. The trigger-secret entry carries a one-line comment: "Sent by the Cloud Scheduler job as the `X-Scheduler-Secret` header; min 32 chars; distinct from WEBSACO3_HMAC_SECRET."

**Copropiedades validation** (`copropiedades.service.ts`): add a new private method.

```ts
private validarActivacionGestionEdificios(
  cambios: Record<string, unknown>,               // output of aDocumento(dto)
  actual: Pick<Copropiedad, 'usesBuildingManagement' | 'taxId' | 'taxIdVerificationDigit'> | null,
): void
```
1. If none of `usesBuildingManagement`, `taxId`, `taxIdVerificationDigit` is `in cambios`, return. This satisfies the spec's "doesn't touch the flag" scenario.
2. Compute the effective value of each key as `k in cambios ? cambios[k] : actual?.[k] ?? null`.
3. If the effective flag is `true`, require `typeof v === 'string' && v.trim() !== ''` for both taxId and the DV. The DV `"0"` passes (spec scenario). Otherwise throw `BadRequestException('Para activar la gestión de edificios la copropiedad debe tener NIT y dígito de verificación.')`.

Where it slots in:
- **`create`**: call `validarActivacionGestionEdificios(this.aDocumento(dto), null)` as the first line, before `siguienteCodigo()` at `:286`, so a rejected request never burns a code.
- **`update`**: before `findByIdAndUpdate` at `:409`:
  1. `const cambios = this.aDocumento(dto)`
  2. `const actual = await this.copropiedades.findById(id).select('usesBuildingManagement taxId taxIdVerificationDigit').lean().exec()`
  3. if `!actual`, throw `NotFoundException`
  4. `validarActivacionGestionEdificios(cambios, actual)`
  5. `$set: cambios`

The existing reuse of `aDocumento` at `:412` becomes the local `cambios`.

**[spec-gap]:** clearing the NIT while the flag is already on counts as "touching" (the `taxId` key is present in `cambios`), so it is rejected. That matches the requirement text. Legacy rows that have the flag on but no NIT can still be edited in unrelated ways, and the listener skips them with a warning.

## File Changes

| File | Action |
|---|---|
| `src/common/eventos/lote-facturas-pdf-confirmado.event.ts` | Create |
| `src/database/schemas/publicaciones/publicacion-lote.schema.ts` | Create |
| `src/database/database.module.ts` | Modify: register `PublicacionLote` |
| `src/modules/publicacion-facturas/publicacion-facturas.{module,controller,guard,service,listener,mapper,firma,politica,contrato}.ts` | Create |
| `src/modules/publicacion-facturas/*.spec.ts` (controller, guard, service, listener, mapper, firma, politica) | Create |
| `src/modules/facturacion/lotes.controller.ts` | Modify: inject `EventEmitter2`, emit after `:376` |
| `src/modules/facturacion/lotes.controller.spec.ts` | Create (emit test; none exists today) |
| `src/modules/copropiedades/copropiedades.service.ts` (+ spec) | Modify |
| `src/app.module.ts`, `src/config/env.validation.ts`, `src/config/app.config.ts`, `.env.example` | Modify |
| `package.json` | Add `@nestjs/event-emitter` (major compatible with `@nestjs/common` 11; check peer deps at install). **No** `@nestjs/schedule` |

## Testing Strategy

All tests are unit tests with hand-rolled mocks, following the conventions in `backend/CLAUDE.md`.

| Target | What is tested |
|---|---|
| `politica` | Every status class, `retrasoTras` at 1..6 |
| `firma` | Fixed vector (deterministic), and a different ts or body gives a different signature |
| `mapper` | Shape, order preserved, ISO date |
| service `encolar` | Flag off → no write; `$setOnInsert` upsert; E11000 swallowed |
| service `reclamar` | Asserts the exact filter/update, including the stale branch and `attempts<max` |
| service `procesar` | Mocked `fetch`: 201/202/409/422/502/401/403/timeout → outcomes; `urlSigned` is never passed to the logger (spy on `Logger`) |
| service `liberar` | Token mismatch → no-op and a warning |
| service config | Unconfigured → `procesarPendientes` does nothing |
| service budget | Loop stops claiming once the budget would be exceeded (fake clock); leftover rows remain claimable |
| service overlap | Second concurrent call → `omitido: true`, no claim |
| guard | Missing config / missing header / wrong header → 401; correct header → pass; header value never logged |
| controller | Awaits `procesarPendientes` and returns its `ResumenCiclo` (direct instantiation) |
| listener | Errors never propagate |
| `LotesController` | `emitAsync` called with the page-ordered numbers |
| `copropiedades` | All 7 spec scenarios |

## Migration / Rollout

No data migration. `usesBuildingManagement` defaults to false. Rollout order:
1. The WebSaco3 receiver is live.
2. The HMAC secret is provisioned on both sides.
3. The env vars are set, including `WEBSACO3_PUBLICACION_TRIGGER_SECRET`.
4. The Cloud Scheduler job is created (see Open Questions).
5. Flip the flag per coproperty.

Rollback is described in the proposal.

## Open Questions

- [ ] **Provision the Cloud Scheduler job (infra/deploy task, outside this repo's code, done alongside deployment):**
  - cron expression `* * * * *`, matching the 1-minute first backoff step
  - target `POST https://<service>/api/v1/interno/publicacion-facturas/procesar-pendientes`
  - header `X-Scheduler-Secret: <same value as WEBSACO3_PUBLICACION_TRIGGER_SECRET>`
  - attempt deadline above `PRESUPUESTO_CICLO_MS` (keeping the 180 s default is fine)
  - Scheduler's own retries set to 0 or kept low, because the next minute's tick is the retry

  Without this job, rows enqueue but are never sent.
- [ ] Should `nit` carry only `taxId`, or `taxId-DV`? The design sends `taxId` only. This must be confirmed with WebSaco3.
- [ ] The spec's response table needs amending to match the full `clasificarRespuesta` mapping above.
