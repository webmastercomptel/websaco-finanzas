# Archive Report: publicar-facturas-websaco

**Archived**: 2026-09-24  
**Change**: publicar-facturas-websaco  
**Artifact Store**: openspec  
**Status**: COMPLETE — Ready for deployment  

---

## Executive Summary

The `publicar-facturas-websaco` change has been successfully completed, verified (PASS WITH WARNINGS), and archived. All 22 tasks across 11 phases have been implemented and tested. The change adds an optional outbound publishing edge that emits confirmed invoice batches to an external WebSaco3 system via HMAC-signed requests, with atomic retry logic and exponential backoff. The billing domain remains unaware of the publishing mechanism; it can be entirely removed by deleting one module. Two new domain capabilities are now available as sources of truth: `invoice-batch-publication` and `building-management-activation`.

---

## What Shipped

### Core Capabilities

1. **`invoice-batch-publication`** (new domain capability)
   - Event-driven outbox pattern for publishing confirmed invoice batches
   - Idempotent row creation keyed by batch ID (loteId)
   - HMAC-SHA256 signed POST requests to external receiver
   - Atomic row claiming for concurrent-safe retry sweeps
   - Exponential backoff (1m, 5m, 15m, 1h) with configurable max attempts
   - Per-response-code state and retry-eligibility classification
   - Triggered by external Cloud Scheduler job (protected by shared-secret header)
   - No in-process timers; all work happens inside a triggered HTTP request

2. **`building-management-activation`** (new domain capability)
   - NIT completeness validation that gates the `usesBuildingManagement` flag
   - Rejects flag activation without a complete NIT (taxId + verificación digit)
   - Allows flag-independent updates to proceed without validation
   - 7 scenario coverage: create/update with various NIT states

### Module Structure

```
src/modules/publicacion-facturas/
├── publicacion-facturas.module.ts          (wiring, no dependencies)
├── publicacion-facturas.service.ts         (core logic: encolar, reclamar, procesar, liberar, barrerAgotados, procesarPendientes)
├── publicacion-facturas.controller.ts      (internal endpoint: POST /interno/publicacion-facturas/procesar-pendientes)
├── publicacion-facturas.guard.ts           (SecretoProgramadorGuard: shared-secret header validation)
├── publicacion-facturas.listener.ts        (@OnEvent handler, error-swallowing)
├── publicacion-facturas.mapper.ts          (pure: construirPayload)
├── publicacion-facturas.firma.ts           (pure: HMAC signing)
├── publicacion-facturas.politica.ts        (pure: constants, response classification, backoff)
├── publicacion-facturas.contrato.ts        (types: outbound payload, ResumenCiclo)
└── *.spec.ts (7 test files, full scenario coverage per testing strategy)

src/common/eventos/
└── lote-facturas-pdf-confirmado.event.ts   (domain event, shared with facturacion)

src/database/schemas/publicaciones/
└── publicacion-lote.schema.ts              (outbox: 13 fields, 3 indexes, timestamps)

src/modules/facturacion/
└── lotes.controller.ts (MODIFIED)          (inject EventEmitter2, emit after line 376)
└── lotes.controller.spec.ts (NEW)          (emit test, page-order assertion)

src/modules/copropiedades/
└── copropiedades.service.ts (MODIFIED)     (NIT validation: create + update)
└── copropiedades.service.spec.ts (MODIFIED) (7 scenario coverage)

src/app.module.ts (MODIFIED)                (register EventEmitterModule, PublicacionFacturasModule)
src/config/env.validation.ts (MODIFIED)     (4 new Joi rules + all-or-none chain)
src/config/app.config.ts (MODIFIED)         (4 new config accessors, no ?? fallbacks)
.env.example (BLOCKED)                      (sandbox permission system blocks .env* writes)
package.json (MODIFIED)                     (@nestjs/event-emitter added, no @nestjs/schedule)
```

### Test Coverage

- **Total tests**: 1354 (was 1342 before Phase 11, +12 new)
- **publicacion-facturas scoped**: 100 tests (was 88, +12 from W4 closure)
- **Coverage**: 93.4% statements, 84.9% branches, 95.0% lines
- **All scenarios**: COMPLIANT (W4 test gaps closed in Phase 11)

---

## Open Items for the User (Manual Steps Required)

### 1. Add 4 lines to `.env.example` (cannot be done by agent)

Sandbox permissions block all `.env*` file edits. Add these entries by hand:

```bash
# At the end of .env.example:

# WEBSACO3_FACTURAS_ENDPOINT_URL=
# WEBSACO3_HMAC_SECRET=
# WEBSACO3_PUBLICACION_TRIGGER_SECRET=
# WEBSACO3_PUBLICACION_MAX_INTENTOS=6
```

(See design.md "Config" section for the full comment on the trigger-secret entry.)

### 2. Provision the Cloud Scheduler job (infra/deployment task)

Create a Google Cloud Scheduler job with these settings (outside this repo):

- **Cron expression**: `* * * * *` (every minute, matching the 1m first backoff step)
- **Target**: `POST https://<service>/api/v1/interno/publicacion-facturas/procesar-pendientes`
- **Header**: `X-Scheduler-Secret: <WEBSACO3_PUBLICACION_TRIGGER_SECRET>` (the value from env)
- **Attempt deadline**: keep the default 180s (above PRESUPUESTO_CICLO_MS=120s)
- **Scheduler retries**: 0 or keep low (the next minute's tick is the retry)

Without this job, outbox rows enqueue but are never sent.

### 3. Handoff the contract to the WebSaco3 implementer

The external `POST /api/v1/facturas-externas/recepcion` endpoint must be implemented elsewhere. The contract is fixed in:

**File**: `openspec/specs/invoice-batch-publication/spec.md`  
**Also**: design.md "HMAC" section (critical implementation detail)

Key points for WebSaco3 receiver:
- Verify the HMAC over **raw request bytes** (not re-parsed JSON)
- Compare using `timingSafeEqual(sha256(provided), sha256(expected))` — hash first to equalize length
- Reject when `|now − timestamp| > 300 seconds`
- Treat `loteId` as the idempotency key; return 409 on repeat (a stale re-claim can deliver twice)
- Response codes: 2xx and 409 = success (final), 422/429/5xx = retryable, 401/403/other-4xx = terminal

### 4. Separate the concurrent working-tree edits before committing

Per tasks.md Phase 10: Commit 7b35930 contains this change mixed with unrelated paginaEnLote work.

**Files affected**:
- `src/modules/facturacion/lotes.controller.ts` (RISKY — both changes here)
- Other concurrent edits belong to a separate session

Before the PR:
1. `git diff src/modules/facturacion/lotes.controller.ts` to review the diffs
2. Use `git add -p` to stage only this change's sections (EventEmitter2 injection + emit call after line 376)
3. Stage only the files in design.md's "File Changes" table
4. Leave the concurrent edits unstaged

---

## Specs Merged to Main Repository

Two delta specs were merged as new main specs in `openspec/specs/` (first-time init, no pre-existing specs):

| Domain | Path | Scenarios | Status |
|--------|------|-----------|--------|
| `building-management-activation` | `openspec/specs/building-management-activation/spec.md` | 7 scenarios (create/update with various NIT states) | MERGED |
| `invoice-batch-publication` | `openspec/specs/invoice-batch-publication/spec.md` | 7 requirements, 18 scenarios | MERGED |

---

## Archive Structure

Change folder moved from `openspec/changes/publicar-facturas-websaco/` to:

```
openspec/changes/archive/2026-09-24-publicar-facturas-websaco/
├── proposal.md
├── design.md
├── tasks.md
├── verify-report.md
├── specs/
│   ├── building-management-activation/spec.md
│   └── invoice-batch-publication/spec.md
└── ARCHIVE-REPORT.md (this file)
```

The archived folder is the audit trail. The specs are now the source of truth in `openspec/specs/`.

---

## Artifact Traceability (OpenSpec Mode)

All artifacts persisted to filesystem per openspec-convention:

| Artifact | Path | Purpose |
|----------|------|---------|
| Config | `openspec/config.yaml` | Project SDD context and rules |
| Main specs | `openspec/specs/building-management-activation/spec.md` | Source of truth for NIT activation |
| Main specs | `openspec/specs/invoice-batch-publication/spec.md` | Source of truth for batch publication |
| Proposal | `openspec/changes/archive/2026-09-24-publicar-facturas-websaco/proposal.md` | Intent, scope, approach, rollback |
| Design | `openspec/changes/archive/2026-09-24-publicar-facturas-websaco/design.md` | Architecture decisions, data flow, state machine, interfaces, testing strategy |
| Tasks | `openspec/changes/archive/2026-09-24-publicar-facturas-websaco/tasks.md` | 11 phases, 22 sub-tasks, all marked complete |
| Verify report | `openspec/changes/archive/2026-09-24-publicar-facturas-websaco/verify-report.md` | PASS WITH WARNINGS; all scenarios COMPLIANT after W4 closure |
| Archive report | `openspec/changes/archive/2026-09-24-publicar-facturas-websaco/ARCHIVE-REPORT.md` | This document |

---

## Verification Summary

**Status**: PASS WITH WARNINGS (all critical issues resolved)

| Gate | Result | Notes |
|------|--------|-------|
| Typecheck | PASS | 0 errors |
| Lint | PASS | 0 warnings on change-owned files |
| Tests | PASS | 1354/1354 passed; 1 pre-existing unrelated suite failure (consultas.controller.spec.ts, @react-pdf issue) |
| All 18 spec scenarios | COMPLIANT | W4 test gaps closed in Phase 11 |
| Rollback test | PASS | Deleting PublicacionFacturasModule leaves everything compiling |

**Warnings** (non-blocking for archive):
- W1: Commit 7b35930 has concurrent unrelated work mixed in (tasks.md notes separation steps)
- W2: .env.example still needs the 4 entries (sandbox limitation, not a code issue)
- W3: Proposal text drift (says "@Cron" but design uses Cloud Scheduler; minor doc issue)

**Suggestions** (optional, left open):
- S3: Add header signature test (optional, out of Phase 11 scope)
- S4: Add PublicacionFacturasModule DI smoke test (optional, out of scope)

---

## Rollback Path (Verified)

To disable the entire publishing edge without breaking anything:

```typescript
// In src/app.module.ts:
// 1. Delete the line:  PublicacionFacturasModule,

// 2. Keep EventEmitterModule.forRoot() — it stays because LotesController injects EventEmitter2
//    regardless of whether anything listens.

// 3. Delete the module folder: src/modules/publicacion-facturas/

// 4. Delete the schema: src/database/schemas/publicaciones/publicacion-lote.schema.ts

// 5. In database.module.ts, remove PublicacionLote from the models array.

// 6. Revert copropiedades.service.ts and facturacion/lotes.controller.ts edits (or keep them — 
//    the listener becomes a no-op when nothing subscribes).

// Everything still compiles and runs. The outbox collection is inert.
```

---

## Next Steps

1. **User action**: Add 4 entries to `.env.example` (cannot be automated)
2. **Infra team**: Provision the Cloud Scheduler job with the settings above
3. **Code review + merge**: Verify the PR, separate concurrent edits if needed, merge to main
4. **Deployment**: Deploy to Cloud Run with new env vars set
5. **WebSaco3 team**: Implement the receiver endpoint per the spec contract
6. **Per-coproperty rollout**: Once both systems are live and the job is running, flip the flag per coproperty as needed

---

## Lessons Learned / Design Decisions (for future changes)

1. **Event location matters**: Placing the event in `common/eventos/` instead of the publisher module allows clean deletion (the domain never imports the publisher).
2. **Await the whole cycle**: Awaiting `procesarPendientes()` before returning 200 ensures Cloud Run allocates CPU. Fire-and-forget would recreate the throttling problem.
3. **Atomic claims over race conditions**: A single `findOneAndUpdate` with the right predicate beats any distributed lock for retries.
4. **Fresh signed URLs per attempt**: Retries stay deterministic because batch data is frozen; only the URL is fresh. This solves the "expired URL" failure mode.
5. **Never log sensitive URLs**: Even truncation leaks the pattern. Use spies on the Logger in tests to catch accidental logging.

---

## Configuration Reference

Three env vars (all-or-none via Joi):

```
WEBSACO3_FACTURAS_ENDPOINT_URL    - receiver URL (required https in production)
WEBSACO3_HMAC_SECRET               - shared secret for signing (min 32 chars)
WEBSACO3_PUBLICACION_TRIGGER_SECRET - shared secret for Cloud Scheduler header (min 32, distinct from HMAC secret)
WEBSACO3_PUBLICACION_MAX_INTENTOS  - total attempt count (1-20, default 6)
```

All four accessed via `ConfigService` in the service and guard. Unconfigured → the sweep does nothing and the trigger endpoint fails closed (401).

---

## Commit Message Template

```
feat(publicacion-facturas): invoice batch publication with NIT activation

Add optional outbound edge that publishes confirmed invoice batches to WebSaco3.

- New domain event lote-facturas.pdf-confirmado emitted after FV PDF confirmed
- Outbox with atomic retry sweep (Cloud Scheduler triggered, no in-process cron)
- HMAC-SHA256 signed requests with exponential backoff (1m, 5m, 15m, 1h)
- NIT completeness validation gates the usesBuildingManagement flag
- 22 tasks across 11 phases, all tested and verified
- Module is cleanly removable; domain unaware of publishing

Specs: invoice-batch-publication, building-management-activation
Closes: [PR if applicable]
```

---

**Archived and ready for next phase.**
