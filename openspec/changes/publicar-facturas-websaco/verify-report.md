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
| NIT completeness | Update does not touch the flag | ... actualizar sin tocar el flag | PARTIAL: the fixture already has a complete NIT, so the test would still pass if the validation ran. It does not prove "MUST NOT run" |
| NIT completeness | DV "0" counts as present | ... digito de verificacion "0" | COMPLIANT |
| Event trigger | Enabled coproperty gets a pendiente row | lotes.controller.spec > emite ... mismo orden + service.spec > encolar upsert | COMPLIANT |
| Event trigger | Disabled coproperty gets no row | service.spec > encolar flag apagado | COMPLIANT |
| Idempotent outbox | Duplicate event | service.spec > setOnInsert upsert + E11000 swallowed | PARTIAL: mock-level only. The unique index and setOnInsert are confirmed by reading the code |
| Signed payload | Deterministic signature | firma.spec > es deterministica | COMPLIANT |
| Signed payload | Expired URL is replaced by a fresh one on retry | none asserts it directly | PARTIAL: procesar always calls generarUrlLectura first (code read). No test asserts one call per attempt |
| Response codes | 201/202/409 -> enviado | service.spec > HTTP %i enviado | COMPLIANT |
| Response codes | 422/502 -> fallido, retryable | service.spec > HTTP %i reintentable | COMPLIANT |
| Response codes | 401/403 -> fallido, terminal | service.spec > HTTP %i terminal | COMPLIANT |
| Backoff/exhaustion | Max retries exhausted | service.spec > reclamar attempts<max + agoto max queda terminal | PARTIAL: barrerAgotados runs but none of its filters or updates are asserted |
| Atomic claim | Two instances race | service.spec > reclamar filtro/update atomico | PARTIAL: only the shape is asserted, and the lte date values are not pinned. Atomicity is a MongoDB single-document guarantee, confirmed by reading the code |
| URL never logged | Send attempt is logged | service.spec > urlSigned nunca llega al logger | PARTIAL: only the 422 path runs, although the test title says "ni en exito ni en fallo" |

**Compliance summary**: 12 of 18 scenarios COMPLIANT and 6 PARTIAL. None are UNTESTED or FAILING.

### Correctness (Static Evidence): focus areas
1. Atomic claim: CORRECT. reclamar is a single findOneAndUpdate. The filter is attempts < max
   AND (due pendiente/fallido with retryable true, OR enviando with claimedAt older than
   CLAIM_TTL). The update sets status enviando, a fresh claimedAt and a randomUUID token, and
   increments attempts. After one claim wins, the row matches neither branch: it is no longer
   pendiente/fallido, and its claimedAt is fresh. So a concurrent claimant gets null. liberar
   only writes when the token matches, and logs a warning when modifiedCount is 0. The
   implementation matches design.md line for line.
2. Trigger: CORRECT. @nestjs/schedule is not in package.json. The only @Cron hits in src/ are in
   doc comments. The route is POST interno/publicacion-facturas/procesar-pendientes, with
   UseGuards(SecretoProgramadorGuard) and HttpCode(200), and it awaits the cycle. There is no
   global APP_GUARD and no tenant middleware.
3. HMAC: CORRECT. firmar signs timestamp + "." + rawBody with HMAC-SHA256 and hex output. The
   service computes rawBody = JSON.stringify(payload) once, signs it, and passes that same
   variable as the fetch body, so nothing is re-serialized. The timestamp is Unix seconds. The
   headers are X-Websaco-Timestamp and X-Websaco-Signature: sha256=HEX.
4. NIT validation: CORRECT. The early return fires when none of the three keys is in cambios.
   The effective value comes from cambios when the key is present, otherwise from actual, and
   otherwise null. Both values must be non-blank strings, so the string "0" passes; the DTO
   types digitoVerificacion as a string. aDocumento drops undefined, so an omitted field is
   "not touched". create validates before siguienteCodigo(). update fetches actual with
   select+lean, returns 404 when it is missing, then validates. Case by case: flag + NIT on
   file -> accepted; flag + no NIT anywhere -> rejected; an update that leaves the flag
   untouched -> skipped.
5. Response classification: MATCHES THE DESIGN. 200-299 and 409 -> enviado. 422, 429 and any
   status >= 500 -> reintentar. Everything else, including 401/403 and other 4xx -> terminal. A
   network error, timeout (AbortError) or generarUrlLectura failure -> retry with a null status.
   This is the broader mapping from design.md. It agrees with the spec on every code the spec
   lists; the extra codes are the spec-gap the design describes. The spec table itself was NOT
   amended (W3).
6. Env vars: CORRECT IN CODE, .env.example STILL OPEN. All 4 keys are in env.validation.ts with
   the exact Joi rules from the design. The URL requires https in production. The two secrets
   need min(32). MAX_INTENTOS is an int from 1 to 20 with default 6.
   .and(URL, HMAC, TRIGGER_SECRET) is chained on the object. app.config.ts maps all 4 with no
   nullish fallback. .env.example was last changed in dc5b75a, so this change never touched it.
7. Tests: REAL, NOT TAUTOLOGICAL. The tests exercise real branches: the clasificarRespuesta
   classes, the guard fail-closed and wrong-header cases, the budget loop under fake timers
   (3 claims, then it stops), same-instance overlap, a token mismatch, and E11000. The gaps are
   the PARTIAL rows above.

### Coherence (Design)
| Decision | Followed? | Notes |
|---|---|---|
| 1 Event lives in common/ | Yes | facturacion imports only common/eventos |
| 2 Awaited emitAsync, listener swallows errors | Yes | Tested |
| 3 Snapshot at enqueue, URL fresh on each attempt | Yes | |
| 4/4b Outbox sweep started by an external trigger, no cron | Yes | |
| 4c Shared-secret guard, sha256 then timingSafeEqual, opaque 401 | Yes | The secret value is never logged (tested) |
| 5 Schema registered globally | Yes | database.module.ts |
| 6 Contract types inside the module | Yes | |
| 7 Missing config means the sweep does nothing and the guard fails closed | Yes | Tested |
| Cycle budget, same-instance overlap, barrerAgotados | Yes | MARGEN_CICLO_MS = 5s is a local constant (a reasonable detail the design left open) |
| .env.example updated | No | Tracked open item |

### Issues Found
**CRITICAL**: None.

**WARNING**:
- W1. Commit 7b35930 includes unrelated concurrent work, and tasks.md says otherwise. The
  commit carries the paginaEnLote work: lotes.controller.ts (indice + 1), facturas.service.ts,
  factura.schema.ts, extraer-pagina-pdf.util.ts, documento-storage.service.ts, and the pdf-lib
  dependency. It also adds datos-impresion endpoints to the facturas, notas-* and recibos
  controllers. The Phase 10 note ("made cleanly ... nothing from this change is mixed") is
  inaccurate. Separate the two changes before opening the PR, or record the combined scope
  explicitly.
- W2. .env.example is missing the 4 new vars. This is a known sandbox limitation, not a code
  defect. It still breaks backend rule 1 ("new var -> .env.example entry") until a person adds
  them.
- W3. The spec and proposal have drifted from the implementation. The table in
  invoice-batch-publication/spec.md still lists only 201/202/409/422/502/401/403, and the Open
  Question in design.md about it is still unchecked. proposal.md line 44 still says "A @Cron
  scan". The table should be amended before, or during, the archive merge.
- W4. Test gaps (the PARTIAL scenarios). Nothing asserts: a second claim returning null, the
  lte values in reclamar, generarUrlLectura running on every attempt, the barrerAgotados
  filters, logging on the success/timeout paths, or that the "does not touch the flag" case
  skips validation. For that last one, use a legacy fixture with the flag on and no NIT. The
  ResumenCiclo retry/terminal counters (lines 399-400) are also uncovered.

  **RESOLVED** (follow-up `sdd-apply` batch, see `tasks.md` Phase 11 for full detail and exact
  test names): all 6 partial scenarios now have direct behavioral coverage in
  `publicacion-facturas.service.spec.ts` — `reclamar`'s exclusivity and stale-window boundary
  (via a hand-rolled in-memory fake replaying the same MongoDB predicate, not just filter-shape
  assertions), `generarUrlLectura` called fresh on every `procesar` attempt, `barrerAgotados`'s
  two `updateMany` predicates exercised on both sides (swept vs. left alone), `urlSigned`
  never-logged coverage extended to the success and timeout/network-error paths (previously
  only 422), and the `ResumenCiclo` enviadas/reintentar/terminales counters asserted
  independently in one mixed-outcome cycle. `copropiedades.service.spec.ts`'s "doesn't touch
  the flag" fixture was swapped to a genuinely incomplete NIT (was previously complete, so it
  would have passed even with a validation bug). 12 new tests added, 0 removed, 2 renamed for
  accuracy; full suite still 0 failures (consultas.controller.spec.ts's pre-existing,
  unrelated environment failure aside).

**SUGGESTION**:
- S1. Consume or cancel the response body after fetch (respuesta.body?.cancel()). An unread
  undici body can hold the socket until garbage collection.

  **APPLIED**: `void respuesta.body?.cancel().catch(() => {})` added right after every
  successful `fetch` in `procesar` (every outcome is decided from the status code alone, the
  body is never read). Covered by a new test.
- S2. Set redirect to "error" (or "manual") on the POST. By default a 301/302/303 is followed
  and can downgrade POST to GET, which drops the signed body.

  **APPLIED**: `redirect: 'error'` added to the outbound `fetch` call options. `'error'` was
  chosen over `'manual'` so a followed 3xx is treated exactly like a network failure — retried
  under the existing backoff/max policy through the same `catch` branch already in place —
  rather than introducing a new HTTP-status-0 case into `clasificarRespuesta`. Covered by a new
  test.
- S3. Add a test asserting that the X-Websaco-Signature header equals
  firmar(secret, ts, init.body). That locks the sign-what-you-send invariant.

  Left open — optional, out of scope for the W4-closure batch.
- S4. Add a small DI smoke test for PublicacionFacturasModule, or one that checks the OnEvent
  wiring. The module currently has 0% coverage.

  Left open — optional, out of scope for the W4-closure batch.

### Verdict
PASS WITH WARNINGS.
Every spec requirement is implemented correctly and typecheck, lint and the test suite pass.
The remaining items (commit hygiene, .env.example, spec text drift, partial test coverage) do
not block archive.
