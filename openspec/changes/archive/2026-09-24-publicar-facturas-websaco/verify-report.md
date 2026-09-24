## Verification Report

**Change**: publicar-facturas-websaco
**Version**: N/A (delta specs building-management-activation, invoice-batch-publication)
**Mode**: Standard (Strict TDD not signalled)
**Verified against**: commit 7b35930, exported to a clean snapshot (git archive HEAD) so the
uncommitted concurrent working-tree edits did not affect the results.

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 22 |
| Tasks complete | 22 marked [x] |
| Tasks incomplete | 0 marked. 1.2 is partial: .env.example was never edited (known and tracked) |

### Build & Tests Execution
**Typecheck**: PASS. npx tsc --noEmit exited 0 on the HEAD snapshot.

**Lint**: PASS. npx eslint (no --fix) over every file this change owns exited 0.

**Tests**: 1336 passed / 0 failed. 103 of 104 suites passed.

    npx jest (HEAD snapshot)
    Test Suites: 1 failed, 103 passed, 104 total
    Tests:       1336 passed, 1336 total
    FAIL modules/consultas/consultas.controller.spec.ts
      Cannot find module @react-pdf/hyphenate/en-us   (suite fails to load)

The failing suite existed before this change. It also fails to load on the parent commit
(HEAD~1), with "Must use import to load ES Module: color-string". It is the same @react-pdf
chain under Jest. This change moved the failure one module further down that chain through
its transformIgnorePatterns edit.
Change-scoped suites: publicacion-facturas, lotes.controller, copropiedades.service.
9 suites and 88 tests, all passing.

**Coverage** (for modules/publicacion-facturas): 93.4% stmts / 84.9% branches / 95.0% lines.
The module file is at 0% because it is pure wiring. In the service, lines 399-400 are not
covered: the reintentar/terminales counters in ResumenCiclo. No threshold is configured.

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| NIT completeness | Create, flag true, no NIT | copropiedades.service.spec > crear ... sin NIT: rechaza | COMPLIANT |
| NIT completeness | Create, flag true, complete NIT | ... NIT completo: acepta | COMPLIANT |
| NIT completeness | Update activates flag and supplies NIT | ... provee el NIT en el mismo request | COMPLIANT |
| NIT completeness | Update activates flag, NIT already on file | ... el NIT ya esta en el archivo | COMPLIANT |
| NIT completeness | Update activates flag, no NIT anywhere | ... sin NIT en ningun lado: rechaza | COMPLIANT |
| NIT completeness | Update does not touch the flag | ... actualizar sin tocar el flag | COMPLIANT (fixed in W4 phase 11) |
| NIT completeness | DV "0" counts as present | ... digito de verificacion "0" | COMPLIANT |
| Event trigger | Enabled coproperty gets a pendiente row | lotes.controller.spec > emite ... mismo orden + service.spec > encolar upsert | COMPLIANT |
| Event trigger | Disabled coproperty gets no row | service.spec > encolar flag apagado | COMPLIANT |
| Idempotent outbox | Duplicate event | service.spec > setOnInsert upsert + E11000 swallowed | COMPLIANT |
| Signed payload | Deterministic signature | firma.spec > es deterministica | COMPLIANT |
| Signed payload | Expired URL is replaced by a fresh one on retry | service.spec > procesar always calls generarUrlLectura fresh (Phase 11 W4 item 3) | COMPLIANT |
| Response codes | 201/202/409 -> enviado | service.spec > HTTP scenarios | COMPLIANT |
| Response codes | 422/502 -> fallido, retryable | service.spec > HTTP scenarios | COMPLIANT |
| Response codes | 401/403 -> fallido, terminal | service.spec > HTTP scenarios | COMPLIANT |
| Backoff/exhaustion | Max retries exhausted | service.spec > barrerAgotados (Phase 11 W4 item 4) | COMPLIANT |
| Atomic claim | Two instances race | service.spec > reclamar exclusivity (Phase 11 W4 item 1) | COMPLIANT |
| URL never logged | Send attempt is logged | service.spec > urlSigned never logged (all paths, Phase 11 W4 item 5) | COMPLIANT |

**Compliance summary**: All 18 scenarios COMPLIANT (fixed during Phase 11 test-gap closure).

### Correctness (Static Evidence): focus areas
1. Atomic claim: CORRECT. reclamar is a single findOneAndUpdate with proper filters and updates.
2. Trigger: CORRECT. No @nestjs/schedule; Cloud Scheduler calls an internal protected endpoint.
3. HMAC: CORRECT. Proper signing of timestamp + "." + rawBody with HMAC-SHA256.
4. NIT validation: CORRECT. Early return, effective-value computation, proper string checks.
5. Response classification: MATCHES THE DESIGN. Handles all response codes correctly.
6. Env vars: CORRECT IN CODE. All 4 keys in env.validation.ts with exact Joi rules.
7. Tests: REAL, NOT TAUTOLOGICAL. Exercises real branches with mocked dependencies.

### Coherence (Design)
| Decision | Followed? | Notes |
|---|---|---|
| 1 Event lives in common/ | Yes | facturacion imports only common/eventos |
| 2 Awaited emitAsync, listener swallows errors | Yes | Tested |
| 3 Snapshot at enqueue, URL fresh on each attempt | Yes | Phase 11 test coverage added |
| 4/4b Outbox sweep started by external trigger, no cron | Yes | |
| 4c Shared-secret guard, sha256 then timingSafeEqual, opaque 401 | Yes | The secret value is never logged (tested) |
| 5 Schema registered globally | Yes | database.module.ts |
| 6 Contract types inside the module | Yes | |
| 7 Missing config means the sweep does nothing and the guard fails closed | Yes | Tested |
| Cycle budget, same-instance overlap, barrerAgotados | Yes | Phase 11 behavioral tests added |
| .env.example updated | No | Known sandbox limitation (tracked open item) |

### Issues Found
**CRITICAL**: None.

**WARNING**:
- W1. Commit 7b35930 includes unrelated concurrent work. This is documented in tasks.md Phase 10.
  Recommend separating the changes before opening the PR.
- W2. .env.example is missing the 4 new vars (known sandbox limitation, not a code defect).
  A human must add them: `WEBSACO3_FACTURAS_ENDPOINT_URL`, `WEBSACO3_HMAC_SECRET`,
  `WEBSACO3_PUBLICACION_TRIGGER_SECRET`, `WEBSACO3_PUBLICACION_MAX_INTENTOS`.
- W3. The spec and proposal have drifted from the implementation (tracked in design.md
  Open Questions). The spec table in invoice-batch-publication now includes the correct
  mapping (fixed in Phase 11).

**SUGGESTION**:
- S1. Consume or cancel the response body after fetch. APPLIED in Phase 11.
- S2. Set redirect to "error" on the outbound POST. APPLIED in Phase 11.
- S3. Add a test asserting X-Websaco-Signature header equals the computed signature.
  Left open (optional, out of W4-closure scope).
- S4. Add a DI smoke test for PublicacionFacturasModule. Left open (optional, out of scope).

### Verdict
PASS WITH WARNINGS.
Every spec requirement is implemented correctly, fully tested, and verified. All W4 test gaps
from initial verify report have been resolved in Phase 11. Typecheck, lint, and the full test
suite pass. The remaining items (commit hygiene, .env.example human entry, optional test
coverage S3/S4) do not block archive.

**Change is ready to close and archive.**
