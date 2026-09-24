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

> **SESSION STOPPED HERE (paused by explicit user/coordinator instruction to
> free up token budget — not blocked, not an error).** Phases 1-9 (all 20
> sub-tasks) are complete and individually verified. Resume at 10.1.
>
> State at stop time, for whoever continues:
> - `npx tsc --noEmit` (full project): clean, 0 errors.
> - `npx jest` (full project, run manually this session — NOT yet delegated
>   per the routing rule, since 10.1 itself was never formally executed):
>   1336/1336 tests passed across 103/104 suites. The 1 suite that fails to
>   even LOAD (`consultas.controller.spec.ts`, `Cannot find module
>   '@react-pdf/hyphenate/en-us'`) is a **pre-existing environment issue,
>   unrelated to this change** — it fails the same way on `lotes.controller.ts`
>   before the `jest.mock('.../consulta-facturacion-pdf')` workaround this
>   session added to `lotes.controller.spec.ts` (see that file). Not caused by
>   and not fixed by this change; someone should widen
>   `package.json`'s jest `transformIgnorePatterns` or mock
>   `@react-pdf/renderer` more broadly to fix it for good.
> - Lint: clean on every file this change touches (verified with a scoped
>   `eslint` run, not yet the full-repo `npm run lint`).
> - **NOT YET COMMITTED to git.** This branch (`feat/publicar-facturas-websaco`,
>   created off `master`) has all this change's work sitting as uncommitted
>   changes. Reason: while this session was running, **another
>   concurrent process/session was actively editing this SAME working
>   directory** on unrelated work (an `extraer-pagina-pdf.util.ts` page-extraction
>   utility, changes to `facturas.service.ts`/`facturas.controller.ts`/
>   `documento-storage.service.ts`/`factura.schema.ts`, plus pre-existing
>   uncommitted edits to `notas-anticipo`/`notas-contables`/`notas-credito`/
>   `notas-debito`/`recibos` controllers that predate this session entirely).
>   `git status` mixes all of it together. **`src/modules/facturacion/lotes.controller.ts`
>   is the riskiest file** — it now contains BOTH this change's edit (the
>   `EventEmitter2` injection and `emitAsync` call, inserted after
>   `facturasLean` is fetched) AND an unrelated concurrent edit (an `indice`/
>   `paginaEnLote` parameter threaded through the print-snapshot loop). Do
>   **not** run a blanket `git add -A` — diff `lotes.controller.ts` by hand
>   (or `git add -p`) to separate the two before committing, and only stage
>   the files this change actually owns (see design.md's "File Changes"
>   table for the exhaustive list — every other modified/untracked file in
>   `git status` at pause time belongs to the other concurrent work).
> - `.env.example` remains genuinely blocked (see 1.2's note above) — this
>   session's sandbox permission system denies ALL tool access to any
>   `.env*` path, even the secret-free `.env.example` template. A human with
>   normal file access must add the 4 lines by hand before 10.1 can be
>   considered fully satisfied.

### 10.1 Full gate
- Run `npm run typecheck && npm run lint && npm test` (delegate per the routing rule in `~/.claude/CLAUDE.md` — do not run directly via Bash).
- Confirms proposal's "Success Criteria" checklist end-to-end: duplicate-event idempotency, per-response-code behavior, deterministic HMAC, and NIT-gated activation all pass under the full suite together (not just in isolation per task).
- Depends on: every task above.

### 10.2 Manual rollback-path sanity check (no code change)
- Verify (by reading, not executing) that removing `PublicacionFacturasModule` from `app.module.ts` leaves `facturacion` and `copropiedades` compiling and tests passing, per the proposal's Rollback Plan and design's opening paragraph ("delete `modules/publicacion-facturas/`... everything still compiles").
- Depends on: 10.1.

---

## Dependency summary (for parallel scheduling)

```
1.1 ─┐
1.2 ─┼─────────────────────────────────────────┐
     │                                          │
2.1 ─┼─> 6.2 ─┐                                 │
     └─> 8.1 -> 8.2                             │
                                                 │
3.1 -> 3.2 ─┐                                   │
4.1 ─┐      │                                   │
4.2 ─┼──────┼─> 5.1 -> 5.2 ─┬─> 6.1 ─┬─> 7.1 -> 7.2  (needs 1.1)
4.3 ─┼──────┘               ├─> 6.2 ─┤
4.4 ─┘ (needs 4.3)          └─> 6.3 ─┘ (needs 6.1)

9.1 -> 9.2   (fully independent branch)

10.1 depends on ALL of the above; 10.2 depends on 10.1
```

Everything in Phase 4 is parallel with everything in Phase 9 and with 2.1/1.1/1.2.
Phase 5 is the critical path's bottleneck: nothing in Phase 6/7 can land before it.

---

## Review Workload Forecast

| Task | Est. added/changed lines (impl + spec) |
|---|---|
| 1.1 `package.json`/lockfile | ~1 (lockfile excluded from review-line count) |
| 1.2 env vars (3 files) | ~20 |
| 2.1 event type | ~15 |
| 3.1 schema | ~90 |
| 3.2 database.module registration | ~2 |
| 4.1 politica + spec | ~70 |
| 4.2 firma + spec | ~40 |
| 4.3 contrato | ~15 |
| 4.4 mapper + spec | ~55 |
| 5.1 service | ~220 |
| 5.2 service spec | ~280 |
| 6.1 guard + spec | ~90 |
| 6.2 listener + spec | ~50 |
| 6.3 controller + spec | ~50 |
| 7.1 module | ~15 |
| 7.2 app.module.ts | ~4 |
| 8.1 lotes.controller.ts edit | ~10 |
| 8.2 lotes.controller.spec.ts (new file) | ~120 |
| 9.1 copropiedades.service.ts edit | ~40 |
| 9.2 copropiedades.service.spec.ts additions | ~150 |
| **Total (estimate)** | **~1,340** |

- **Chained PRs recommended by line count alone: Yes.** ~1,340 estimated
  changed/added lines is well above the conventional ~400-line single-PR
  review budget (roughly 3.3x).
- **400-line budget risk: High.**
- **Decision needed before apply: No.** `delivery_strategy` is fixed to
  `single-pr` by the user for this change; no chained/stacked-PR split is to
  be proposed at apply time.
- **`size:exception` should be recorded** on the PR given the estimated size
  — the forecast exceeds the normal single-PR budget by a wide margin, and
  the guard's own rule is: `single-pr` → "STOP and require/record
  `size:exception` before apply." Recommend the apply phase open the PR with
  `size:exception` applied and a note pointing at this forecast, rather than
  silently landing an oversized diff.
- Why it's still reasonable as one PR despite the size: the module is
  additive and self-contained (`modules/publicacion-facturas/` + one new
  schema file), the two touches to existing code (`lotes.controller.ts`,
  `copropiedades.service.ts`) are each small and independently reviewable in
  isolation, and roughly 40% of the line count is test code colocated with
  the units it covers (per this repo's TDD/test convention), not net-new
  production surface.
