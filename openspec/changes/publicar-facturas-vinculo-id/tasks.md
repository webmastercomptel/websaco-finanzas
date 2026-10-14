# Tasks: Link invoice publication to WebSaco3 by `_id`

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~700 total (PR 1 ~200, PR 2 ~250, PR 3 ~80, PR 4 ~190) |
| 400-line budget risk | High as a single PR; Low per slice (each PR under 400) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 copropiedades id -> PR 2 publication -> PR 3 docs + curl runbook (+ stale-dir deletion in its own commit) -> PR 4 frontend |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Coproperty `websaco3CopropiedadId`: schema, DTO, service rule, mapper, tests (tasks 1.1-1.6) | PR 1 | Base = main (stacked) or tracker branch (feature-branch-chain). Deploy FIRST |
| 2 | Publication: payload, `encolar` boolean, send-time resolution, 45 s timeout, `reclamar(max, loteId?)`, `publicarAhora`, listener, tests, `CLAUDE.md` row (tasks 1.7-1.16) | PR 2 | Depends on PR 1; base = PR 1 branch if feature-branch-chain |
| 3 | Runbook with manual `curl`, `INSTALACION-REFERENCE`, `README`, `.env.example`; stale-dir deletion as its own commit (tasks 2.x) | PR 3 | Docs only; base = PR 2 branch if feature-branch-chain |
| 4 | Frontend input + validation (tasks 3.x) | PR 4 | Needs PR 1 deployed (`forbidNonWhitelisted`); base = PR 3 branch if feature-branch-chain |

Deploy order: WEBSACO3 receiver -> PR 1 -> PR 4 (backend before frontend) -> load ids into ALL legacy flagged coproperties -> PR 2 + PR 3 -> 4 `WEBSACO3_*` env vars -> one manual `curl` to drain legacy rows -> re-arm terminal rows. Ids MUST be loaded BEFORE the coproperty's next lote is confirmed on PR 2 code: otherwise `encolar` skips with a warning and that lote is NOT recovered.
Deploy PR 1 and PR 4 TOGETHER: between them the existing frontend form always sends `usaGestionEdificios`, so editing a legacy flagged coproperty without an id returns 400 until PR 4 (the id input) ships.
Tests are written test-first per task (`tdd: false` in `openspec/config.yaml`: recommended, not enforced). Paths are under `backend/` unless noted.

## Phase 1: Backend (verify: `npm run typecheck && npm run lint && npm test`, delegated; rollback: revert the PR)

### PR 1: copropiedades id (field is inert if reverted)

- [x] 1.1 Schema: add `websaco3CopropiedadId` to `src/database/schemas/copropiedades/copropiedad.schema.ts` and to `Copropiedad` in `src/contracts/index.ts` (Req: WebSaco3 coproperty id required on activation)
- [x] 1.2 RED/GREEN `copropiedades.mapper.ts` + spec: legacy doc without the field maps to `null` (Req: same)
- [x] 1.3 RED/GREEN `dto/guardar-copropiedad.dto.ts`: `@IsOptional() @Matches(WEBSACO3_COPROPIEDAD_ID_REGEX)` (shared `/^[0-9a-f]{24}$/i` in `websaco3-copropiedad-id.ts`, also used by the service; `@IsMongoId` is NOT used because it accepts a `0x`/`0h` prefix); rejects `"123"`, non-hex, 23/25 chars and `0x`/`0h`-prefixed ids, accepts uppercase hex (Req: same, malformed id)
- [x] 1.4 RED `copropiedades.service.spec.ts`: create valid/missing, reuses stored id, untouched flag no-op, flag on with null id = 400, incomplete NIT no longer blocks (Req: same)
- [x] 1.5 GREEN `copropiedades.service.ts`: `aplicarReglaGestionEdificios(cambios, actual)`, `aDocumento`, `update` selects both keys; remove NIT gate (Req: same)
- [x] 1.6 RED/GREEN service specs: flag off clears the stored id; id supplied while off is dropped (Req: Id is cleared when the flag is turned off)

### PR 2: publication (depends on PR 1)

- [x] 1.7 RED/GREEN `publicacion-facturas.mapper.ts` + `.contrato.ts`: `construirPayload(fila, id, url, exp)`, `nit` replaced by `websaco3CopropiedadId`, order preserved (Req: Signed payload contract)
- [x] 1.8 Drop `nit` `@Prop` from `src/database/schemas/publicaciones/publicacion-lote.schema.ts`; update docblock (Req: Id resolved from the current coproperty at send time)
- [x] 1.9 RED/GREEN `publicacion-facturas.service.ts` `encolar`: returns `Promise<boolean>` (false on flag on without id = warn, no write; true on upsert and on 11000 race); no `nit` in `$setOnInsert` (Req: Event trigger scoped to enabled coproperties)
- [x] 1.10 RED/GREEN `procesar`: read `Copropiedad` before signing; missing id or flag off = terminal `sin-websaco3-id` with no `generarUrlLectura` or `fetch`; `findById` throws = retry `copropiedad-lectura`; corrected id used; legacy `nit` row sends no `nit` (Req: Id resolved...; Response code determines state)
- [x] 1.11 `publicacion-facturas.politica.ts`: `FETCH_TIMEOUT_MS = 45_000` with cold-start docblock; `PRESUPUESTO_CICLO_MS` docblock cites the operator `curl` (no Cloud Scheduler); drop `[spec-gap]`. Tests: invariants `FETCH_TIMEOUT_MS + MARGEN_CICLO_MS < PRESUPUESTO_CICLO_MS` and `< CLAIM_TTL_MS`; 400/404 terminal (Req: Response code determines state)
- [x] 1.12 RED/GREEN `reclamar(max, loteId?)`: optional `loteId` filter, same atomic claim; specs with and without filter (Req: Immediate dispatch on confirmation)
- [x] 1.13 RED/GREEN `publicarAhora(loteId)` (no `enEjecucion` lock): transport not configured = no claim; claims with `loteId`; null claim = no fetch; success = `liberar` `enviado`; fetch timeout = retryable `fallido` (Req: Immediate dispatch on confirmation)
- [x] 1.14 RED/GREEN `publicacion-facturas.listener.ts`: `if (await encolar(e)) await publicarAhora(e.loteId)`, all inside the catch-all; specs: only called when `encolar` is true, a throw from either is swallowed (Req: Immediate dispatch on confirmation)
- [x] 1.15 `lotes.controller.ts`: comment only at the `emitAsync` call, stating the awaited emit now also covers the send
- [x] 1.16 `CLAUDE.md`: replace the `PublicacionLote` `nit` canonical row with `websaco3CopropiedadId`

## Phase 2: Docs and cleanup, PR 3 (verify: links resolve, `curl` reviewed against the guard; rollback: revert)

- [x] 2.1 Create `docs/runbooks/publicacion-websaco3.md`: 4 env vars, immediate-dispatch behaviour, Mongo query for rows `pendiente`/retryable `fallido`/stale `enviando`, manual `curl -X POST` with `X-Scheduler-Secret` and `--max-time 150` (no `gcloud scheduler`), re-arming terminal rows, rollout order (Req: Manual sweep safety net documented)
  - The runbook MUST also document the scenario "`liberar` fails after a successful POST": the row stays `enviando` until `CLAIM_TTL_MS`; if `intentos >= max`, `barrerAgotados` can mark it terminal `reclamo-expirado` even though WebSaco3 already received it. The operator MUST check WebSaco3 before re-sending. The receiver dedupes by `loteId` and answers 409, which counts as success.
  - PR 3 MUST reword the stale docblock of `publicacion-facturas.controller.ts` ("Cloud Scheduler trigger") to "manual safety-net trigger" (the controller is intentionally NOT edited in PR 2).
  - Done in PR 3: controller docblock reworded (comment-only). Other stale "Cloud Scheduler" mentions in `src/` fixed too (comment-only): controller method docblock, `publicacion-facturas.guard.ts` docblock, `env.validation.ts` comment, and the secret fixture string in `publicacion-facturas.guard.spec.ts`.
- [x] 2.2 `INSTALACION-REFERENCE.md`: Copropiedad field row; `README.md`: link to the runbook
- [ ] 2.3 `.env.example`: add the 4 `WEBSACO3_*` keys, commented out. **Apply could not read this file (permission denied): ask the user for permission first** (Req: same)
  - BLOCKED (permission denied again in PR 3 apply; no workaround attempted). The exact lines to add are in `docs/runbooks/publicacion-websaco3.md`, section "Lines to add to .env.example". A human must append them; then tick this task.
- [ ] 2.4 Separate deletion-only commit: remove `openspec/changes/publicar-facturas-websaco/` (stale copy of `archive/2026-09-24-publicar-facturas-websaco`)
  - NOT DONE: verified in PR 3 apply that the directory is NOT a pure duplicate. `design.md`, `proposal.md` and both `specs/*/spec.md` are identical to the archive, but `tasks.md` and `verify-report.md` differ: the stale copies are the longer originals (the archive holds condensed rewrites). Only in the stale `tasks.md`: the "SESSION STOPPED HERE" block, Phase 10 follow-up note, the detailed Phase 11 notes, the dependency summary and the original Review Workload Forecast. Only in the stale `verify-report.md`: the original PARTIAL compliance rows, the detailed "Findings" analysis 1-7, the full W1-W4 / S1-S4 text. (The archive has `ARCHIVE-REPORT.md`, which the stale dir lacks.) A human must decide whether that detail is disposable before deleting.

## Phase 3: Frontend, PR 4 (`../frontend`; verify: typecheck, lint, Vitest, delegated; rollback: revert, backend ignores the missing field)

- [x] 3.1 RED/GREEN `src/lib/websaco3.ts` + `.test.ts`: `esIdWebsaco3` (valid, uppercase, 23/25 chars, non-hex, `0x`/`0h`-prefixed). It MUST use the same strict regex as the backend, `/^[0-9a-f]{24}$/i` (`WEBSACO3_COPROPIEDAD_ID_REGEX`), and must not rely on any `isMongoId`-style helper, which accepts a `0x`/`0h` prefix (Req: Frontend id input)
- [x] 3.2 `src/lib/api/copropiedades.ts`: add the field to `Copropiedad` and `GuardarCopropiedad`
- [x] 3.3 `src/components/ui/field.tsx`: optional `ayuda`, merged into `aria-describedby` with `error`
- [x] 3.4 RED `src/pages/copropiedad-form.test.tsx`: hidden when off; helper text when on; empty/invalid blocks the mutation with inline error; valid id sent trimmed; flag off = no id in payload (Req: Frontend id input)
- [x] 3.5 GREEN `src/pages/copropiedad-form.tsx` per the design (error, focus, clear on change, keeps state when off)

## Phase 4: Release validation (manual, no code)

- [ ] 4.1 Follow the deploy order above: load the id of EVERY legacy flagged coproperty BEFORE its next lote is confirmed on PR 2 code (otherwise `encolar` skips with a warning and the lote is not recovered); only then set the env vars (Req: Immediate dispatch on confirmation)
- [ ] 4.2 E2E against WebSaco3 once `finanzas-webhook-receptor` is deployed: (a) confirm a lote and verify the row ends `enviado` with no `curl`; (b) separately test the manual `curl` with a valid secret (drains a pending row) and without it (rejected) (Req: Immediate dispatch on confirmation; Manual sweep safety net documented)
- [ ] 4.3 Validate the deployed Cloud Run request timeout of Finanzas (design assumes the default 300 s; worst-case confirm is ~55 s)

## Open questions / not planned

- Uniqueness of `websaco3CopropiedadId` across coproperties: out of scope, no task.
- Showing the id in `copropiedad-detalle.tsx`: out of scope, no task.
- Frontend retry button: decided none; `client.ts` untouched.
