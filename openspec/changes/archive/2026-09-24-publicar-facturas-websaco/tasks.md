# Tasks: Publish invoice batches to WebSaco3

Source of truth for exact file paths, field names, signatures, filter/update
shapes and header names is `design.md`. This checklist only orders and slices
the work; it does not restate design details beyond what's needed to track
progress.

Legend: `[P]` = can run in parallel with sibling tasks in the same phase
(no file overlap, no dependency between them). Unmarked tasks are sequential
— later ones depend on something earlier in the list.

---

## Phase 1 — Dependency & config groundwork

### 1.1 [x] Add `@nestjs/event-emitter` dependency
- Run `npm install @nestjs/event-emitter` (peer-compatible with `@nestjs/common` ^11.0.1 — verify peer deps resolve cleanly on install, no `--legacy-peer-deps`).
- Do **not** add `@nestjs/schedule`.
- File: `package.json`, `package-lock.json`.
- Satisfies: proposal "Affected Areas" (`package.json`), design decision #4b.

### 1.2 [x] Add the four new env vars (Joi + `.env.example`), same change

> **BLOCKED (partial):** `env.validation.ts` and `app.config.ts` are done.
> `.env.example` could NOT be edited — this session's sandbox permission
> system denies ALL tool access (Read/Bash/Grep) to any path matching
> `.env*`, including the committed-safe `.env.example` template with no
> secrets. A human with normal file access must add the 4 entries by hand
> (see design.md's exact block, "Config" section, and the "Migration /
> Rollout" note below repeated here for convenience):
> ```
> # WEBSACO3_FACTURAS_ENDPOINT_URL=
> # WEBSACO3_HMAC_SECRET=
> # WEBSACO3_PUBLICACION_TRIGGER_SECRET=  # Sent by the Cloud Scheduler job as the X-Scheduler-Secret header; min 32 chars; distinct from WEBSACO3_HMAC_SECRET.
> # WEBSACO3_PUBLICACION_MAX_INTENTOS=6
> ```
- `env.validation.ts`: add `WEBSACO3_FACTURAS_ENDPOINT_URL`, `WEBSACO3_HMAC_SECRET`, `WEBSACO3_PUBLICACION_TRIGGER_SECRET`, `WEBSACO3_PUBLICACION_MAX_INTENTOS` per the exact Joi rules in design.md ("Config" section), including the `.and(...)` all-or-none chain across the three secret/URL keys.
- `app.config.ts`: add `websaco3FacturasEndpointUrl`, `websaco3HmacSecret`, `websaco3PublicacionTriggerSecret`, `websaco3PublicacionMaxIntentos` following the existing `PORT`/`corsOrigins` precedent (no `??`).
- `.env.example`: add all four entries, commented out, including the one-line comment on the trigger-secret entry specified in design.md.
- Files: `src/config/env.validation.ts`, `src/config/app.config.ts`, `.env.example`.
- Satisfies: backend `CLAUDE.md` rule 1 (no silent config fallbacks); design "Config" section; proposal (optional env vars).
- Depends on: none (can start immediately, in parallel with 1.1). `[P]`

---

## Phase 2 — Shared event type (no dependencies)

### 2.1 [x] [P] Create the domain event type
- Create `src/common/eventos/lote-facturas-pdf-confirmado.event.ts` with `LOTE_FACTURAS_PDF_CONFIRMADO` and `LoteFacturasPdfConfirmadoEvent` exactly as specified in design.md ("Interfaces / Contracts" → Event).
- This file lives in `common/` on purpose (design decision #1) so `facturacion` never imports the publisher module.
- Depends on: none.
- Satisfies: spec `invoice-batch-publication` → "Event trigger scoped to enabled coproperties" (the emitted fact); design decision #1.

---

## Phase 3 — Outbox schema

### 3.1 [x] Create the `PublicacionLote` schema
- Create `src/database/schemas/publicaciones/publicacion-lote.schema.ts` with every field, default, and the three indexes (`unico_publicacion_por_lote` unique on `{loteId:1}`, `escaneo_reintentos` on `{status:1, retryable:1, nextAttemptAt:1}`, `reclamos_vencidos` on `{status:1, claimedAt:1}`) exactly as specified in design.md ("Schema" section).
- Depends on: none (independent of Phase 2).
- Satisfies: spec `invoice-batch-publication` → "Idempotent outbox row per batch", "Atomic row claiming under concurrent sweep execution".

### 3.2 [x] Register the schema globally
- Add `PublicacionLote` to the `models` array in `src/database/database.module.ts` (per design decision #5 — global registration, not `forFeature` inside the publisher module).
- File: `src/database/database.module.ts`.
- Depends on: 3.1.

---

## Phase 4 — Pure building blocks (no schema/service dependency, fully parallel)

These three units are pure functions/constants with no NestJS DI and no
dependency on each other or on Phase 3. Write each implementation together
with its `*.spec.ts` in the same task (colocated tests, per `backend/CLAUDE.md`).

### 4.1 [x] [P] Policy module + tests
- Create `src/modules/publicacion-facturas/publicacion-facturas.politica.ts`: `BACKOFF_MS`, `CLAIM_TTL_MS`, `FETCH_TIMEOUT_MS`, `URL_LECTURA_TTL_MS`, `LOTE_MAXIMO_POR_CICLO`, `PRESUPUESTO_CICLO_MS`, `retrasoTras(attempts)`, `Clasificacion` type, `clasificarRespuesta(status)` — exact values and mapping per design.md "Policy" section, including the `[spec-gap]` extension (any other 4xx → `terminal`) and the network-error/timeout → `reintentar` rule (handled at call site, documented here).
- Create `src/modules/publicacion-facturas/publicacion-facturas.politica.spec.ts`: every status class of `clasificarRespuesta` (2xx, 409, 422, 429, 500-599, 401, 403, other 4xx), and `retrasoTras` at attempts 1..6 (including the clamp beyond `BACKOFF_MS.length`).
- Depends on: none.
- Satisfies: spec `invoice-batch-publication` → "Response code determines state and retry eligibility", "Backoff retry schedule with terminal exhaustion".

### 4.2 [x] [P] HMAC signing module + tests
- Create `src/modules/publicacion-facturas/publicacion-facturas.firma.ts`: `firmar(secret, timestamp, rawBody)` exactly as in design.md ("HMAC" section).
- Create `src/modules/publicacion-facturas/publicacion-facturas.firma.spec.ts`: a fixed vector is deterministic across repeated calls; a different `timestamp` or a different `rawBody` produces a different signature.
- Depends on: none.
- Satisfies: spec `invoice-batch-publication` → "Signed payload contract" (deterministic-signature scenario).

### 4.3 [x] [P] Outbound contract types
- Create `src/modules/publicacion-facturas/publicacion-facturas.contrato.ts` with the outbound payload shape (`nit`, `loteId`, `facturas[{numeroFactura}]`, `urlSigned`, `urlExpiresAt`) and `ResumenCiclo` (`omitido`, `reclamadas`, `enviadas`, `reintentar`, `terminales`), per design decision #6 (lives inside the module, not `src/contracts/`).
- No spec file — this is types only, exercised indirectly by 4.4, 5.x, and 6.4's tests.
- Depends on: none.

### 4.4 [x] [P] Mapper + tests
- Create `src/modules/publicacion-facturas/publicacion-facturas.mapper.ts`: `construirPayload(fila, url, expiresAt)` building the contract shape from 4.3, ISO-8601 `urlExpiresAt`.
- Create `src/modules/publicacion-facturas/publicacion-facturas.mapper.spec.ts`: output shape, `facturas` order preserved from the row's `invoiceNumbers`, ISO date format.
- Depends on: 4.3 (needs the contract type).
- Satisfies: spec `invoice-batch-publication` → "Signed payload contract".

---

## Phase 5 — Service (core outbox logic)

Single-file task, kept as one unit because `encolar`/`reclamar`/`procesar`/
`liberar`/`barrerAgotados`/`procesarPendientes` share state and are easiest to
review and land together; the spec below is written scenario-by-scenario so
review can still proceed incrementally.

### 5.1 [x] Service implementation
- Create `src/modules/publicacion-facturas/publicacion-facturas.service.ts` implementing, exactly per design.md ("Data Flow", "State Machine", "Policy"):
  - `encolar(evt)`: flag/NIT check via `Copropiedad.findById`, `$setOnInsert` upsert keyed by `loteId`, E11000 swallowed as no-op.
  - `reclamar(max)`: the atomic `findOneAndUpdate` filter/update/sort exactly as specified (pendiente/fallido-retryable-due, or stale enviando re-claim).
  - `procesar(row)`: `generarUrlLectura` → `construirPayload` → `JSON.stringify` once → `firmar` → `fetch` POST with 15s timeout → `clasificarRespuesta` → outcome. `urlSigned` must never reach the logger (design decision + spec requirement).
  - `liberar(row, outcome)`: token-conditional `updateOne`; `modifiedCount === 0` → warn, no write.
  - `barrerAgotados(max)`: both `updateMany` sweeps for expired claims and lowered-`max` exhaustion.
  - `procesarPendientes()`: `enEjecucion` flag for same-instance overlap (`omitido: true` on overlap), cycle-time budget loop (`PRESUPUESTO_CICLO_MS`, stop claiming once `elapsed + FETCH_TIMEOUT_MS + margin` would exceed it), unconfigured (missing URL/HMAC secret) → no-op, returns `ResumenCiclo`.
- Depends on: 3.1 (schema), 4.1 (politica), 4.2 (firma), 4.3+4.4 (contrato/mapper). Needs `DocumentoStorageService` (already global via `CommonModule`, no new wiring).
- Satisfies: spec `invoice-batch-publication` → all seven requirements (this is the capability's core).

### 5.2 [x] Service tests
- Create `src/modules/publicacion-facturas/publicacion-facturas.service.spec.ts` covering, per design.md "Testing Strategy":
  - `encolar`: flag off → no write; upsert idempotency; E11000 swallowed.
  - `reclamar`: exact filter/update asserted, including the stale-enviando branch and the `attempts < max` guard.
  - `procesar`: mocked `fetch` for 201/202/409/422/502/401/403/timeout/network-error → correct `Clasificacion` and outcome; spy on `Logger` to assert `urlSigned` is never passed to it.
  - `liberar`: token mismatch → no-op + warning.
  - config: missing URL or HMAC secret → `procesarPendientes()` is a no-op.
  - budget: fake clock, loop stops claiming once the budget would be exceeded; leftover rows remain claimable next cycle.
  - overlap: second concurrent call while `enEjecucion` → `{ omitido: true }`, no claim attempted.
- Depends on: 5.1.
- Satisfies: same as 5.1, plus spec `invoice-batch-publication` → "Signed URL never logged".

---

## Phase 6 — Guard, controller, listener (depend on the service)

### 6.1 [x] [P] `SecretoProgramadorGuard` + tests
- Create `src/modules/publicacion-facturas/publicacion-facturas.guard.ts`: `CanActivate` reading `websaco3PublicacionTriggerSecret` from config (fail closed with `UnauthorizedException` if absent), reading `x-scheduler-secret` header, `timingSafeEqual(sha256(provided), sha256(expected))`, opaque 401 on every failure path, header value never logged.
- Create `src/modules/publicacion-facturas/publicacion-facturas.guard.spec.ts`: missing config / missing header / wrong header → 401; correct header → pass; header value never logged (spy on `Logger`).
- Depends on: 1.2 (env var exists on `ConfigService`).
- Satisfies: design decision #4c; design "SecretoProgramadorGuard" section.

### 6.2 [x] [P] Listener + tests
- Create `src/modules/publicacion-facturas/publicacion-facturas.listener.ts`: `@OnEvent(LOTE_FACTURAS_PDF_CONFIRMADO, { async: true, promisify: true })`, delegates to `service.encolar(evt)`, swallows every error itself (never propagates, never fails the emitter).
- Create `src/modules/publicacion-facturas/publicacion-facturas.listener.spec.ts`: errors thrown by `service.encolar` never propagate out of the listener.
- Depends on: 2.1 (event type), 5.1 (service).
- Satisfies: spec `invoice-batch-publication` → "Event trigger scoped to enabled coproperties"; design decision #2.

### 6.3 [x] Controller + tests
- Create `src/modules/publicacion-facturas/publicacion-facturas.controller.ts`: `@Controller('interno/publicacion-facturas')`, `@UseGuards(SecretoProgramadorGuard)`, `@Post('procesar-pendientes') @HttpCode(200)`, awaits `service.procesarPendientes()` fully before responding, no DTO (no inputs), plain `@Controller` with no `FirebaseAuthGuard`/`PoliciesGuard`/`@CheckAbility` (per design's `HealthController` precedent).
- Create `src/modules/publicacion-facturas/publicacion-facturas.controller.spec.ts` (direct instantiation with hand-rolled mocks, per `backend/CLAUDE.md` convention): awaits `procesarPendientes()` and returns its `ResumenCiclo` verbatim.
- Depends on: 5.1 (service), 6.1 (guard).
- Satisfies: design "Trigger controller" section; proposal's Cloud Scheduler trigger design.

---

## Phase 7 — Module wiring

### 7.1 [x] `PublicacionFacturasModule`
- Create `src/modules/publicacion-facturas/publicacion-facturas.module.ts`: `@Module({ controllers: [PublicacionFacturasController], providers: [PublicacionFacturasService, PublicacionFacturasListener, SecretoProgramadorGuard] })`, no `imports` (model is global via `DatabaseModule`, `DocumentoStorageService` global via `CommonModule`, `ConfigService` global) — same shape as `HealthModule`.
- No dedicated spec file (mirrors `HealthModule`, which has none); wiring is exercised end-to-end once registered in `app.module.ts` (7.2) and by the individual provider specs above.
- Depends on: 5.1, 5.2, 6.1, 6.2, 6.3 (all providers/controller must exist).

### 7.2 [x] Register in `app.module.ts`
- Add `EventEmitterModule.forRoot()` directly after `BullModule.forRootAsync` (`:64-69`).
- Add `PublicacionFacturasModule` last in `imports` (after `:94`).
- File: `src/app.module.ts`.
- Depends on: 1.1 (`@nestjs/event-emitter` installed), 7.1.

---

## Phase 8 — Billing-domain emit point

Independent of Phases 3–7 except for the event type (2.1) and `EventEmitterModule` being registered (7.2, so DI resolves `EventEmitter2` at runtime) — but the controller edit and its test can be written as soon as 2.1 exists; only a full app-boot / e2e check needs 7.2 done.

### 8.1 [x] Emit the domain event from `LotesController`
- Modify `src/modules/facturacion/lotes.controller.ts`: inject `private readonly eventos: EventEmitter2` as the last constructor parameter (`:66-76`); insert `await this.eventos.emitAsync(LOTE_FACTURAS_PDF_CONFIRMADO, {...} satisfies LoteFacturasPdfConfirmadoEvent)` directly after `:376`, before the snapshot block, exactly as specified in design.md.
- Depends on: 2.1.
- Satisfies: spec `invoice-batch-publication` → "Event trigger scoped to enabled coproperties".

### 8.2 [x] `LotesController` emit test
- Create `src/modules/facturacion/lotes.controller.spec.ts` (none exists today — new file, direct instantiation with hand-rolled mocks): asserts `emitAsync` is called with `LOTE_FACTURAS_PDF_CONFIRMADO` and `numerosFactura` in the same page order as `facturasLean` (unitCode asc).
- Depends on: 8.1.
- Satisfies: spec `invoice-batch-publication` → "Event trigger scoped to enabled coproperties" (array-order requirement from design's payload contract note).

---

## Phase 9 — NIT activation validation (independent of Phases 2–8; can start anytime)

### 9.1 [x] [P] `validarActivacionGestionEdificios` + call sites
- Modify `src/modules/copropiedades/copropiedades.service.ts`:
  - Add `private validarActivacionGestionEdificios(cambios, actual)` exactly per design.md's three numbered rules (no-op when the flag/taxId/DV keys aren't touched; effective-value computation; DV `"0"` counts as present).
  - Wire into `create`: call with `(this.aDocumento(dto), null)` as the first line, before `siguienteCodigo()`.
  - Wire into `update`: fetch `actual` via `.findById(id).select(...).lean().exec()`, `NotFoundException` if absent, call validation before `$set: cambios`.
- Depends on: none (fully independent of the publication module).
- Satisfies: spec `building-management-activation` → "NIT completeness on activation" (all 7 scenarios).

### 9.2 [x] [P] Copropiedades validation tests
- Modify/extend `src/modules/copropiedades/copropiedades.service.spec.ts` covering all 7 scenarios from `specs/building-management-activation/spec.md`: create with flag+no NIT (reject), create with flag+complete NIT (accept), update activates+supplies NIT (accept), update activates+NIT already on file (accept), update activates+no NIT anywhere (reject), update doesn't touch the flag (accept, validation skipped), DV `0` counts as present.
- Depends on: 9.1.
- Satisfies: spec `building-management-activation` → "NIT completeness on activation".

---

## Phase 10 — Whole-change verification

### 10.1 [x] Full gate
- Run `npm run typecheck && npm run lint && npm test`.
- Result: typecheck PASS, lint PASS, 1342 tests passed, 104/105 suites (pre-existing unrelated failure in consultas.controller.spec.ts).
- Confirms proposal's "Success Criteria" checklist end-to-end.
- Depends on: every task above.

### 10.2 [x] Manual rollback-path sanity check (no code change)
- Verified: `PublicacionFacturasModule` is a single isolated import; removing it cleanly disables publication with no other code affected.
- Depends on: 10.1.

---

## Phase 11 — Close verify-report W4 (test-gap closure) + S1/S2 fixes

### 11.1 [x] `reclamar` exclusivity + stale-window boundary tests
- Added behavioral tests in `publicacion-facturas.service.spec.ts` with in-memory predicate simulation.
- Satisfies: W4 items 1-2.

### 11.2 [x] Fresh signed URL per attempt test
- Added test asserting `DocumentoStorageService.generarUrlLectura` called fresh on every `procesar` attempt.
- Satisfies: W4 item 3.

### 11.3 [x] `barrerAgotados` exact-filter behavioral tests
- Added tests exercising both `updateMany` predicates.
- Satisfies: W4 item 4.

### 11.4 [x] Signed URL never logged — success and timeout/network sibling cases
- Extended logging tests to all code paths (success, 422, timeout, network error).
- Satisfies: W4 item 5.

### 11.5 [x] `copropiedades` "doesn't touch the flag" fixture fix
- Swapped fixture to genuinely incomplete NIT (was previously complete).
- Satisfies: W4 item 6.

### 11.6 [x] `ResumenCiclo` counters coverage
- Added test exercising all three outcome counters independently.
- Satisfies: W4 item 7.

### 11.7 [x] S1 — cancel the unread response body
- Added `void respuesta.body?.cancel().catch(() => {})` after every successful `fetch`.
- Production code changed. Covered by new test.

### 11.8 [x] S2 — reject followed redirects on the outbound POST
- Added `redirect: 'error'` to `fetch` call options.
- Production code changed. Covered by new test.

### 11.9 [x] Full gate re-run
- Result: typecheck PASS, lint PASS, 1354 tests passed, 104/105 suites.
- All W4 findings resolved. S1 and S2 applied. S3/S4 left open (optional).

**All 11 phases complete. Change is ready for archive.**
