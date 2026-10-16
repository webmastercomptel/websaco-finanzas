# Tasks: Expose unit holders to WebSaco3 (read-only endpoint)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~980 total (PR 1 ~250, PR 2a ~280, PR 2b ~300, PR 3 ~150) |
| 400-line budget risk | High as a single PR; Medium per slice (2a/2b near the budget, accepted size exception) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 uniqueness -> PR 2a hmac/firma/guard/Joi -> PR 2b endpoint -> PR 3 immutable `codigo` (+ frontend) |
| Delivery strategy | ask-on-risk (resolved by user: chained PRs, larger PRs accepted) |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

Local branches only, NO push, NO deploy. Each PR branches from the previous merged state of `main` (stacked-to-main). Paths are under `backend/` unless noted. Tests are written test-first (RED then GREEN; `tdd: false` in config means recommended, not enforced). Verify each PR with `npm run typecheck && npm run lint && npm test`, delegated.

| Unit | Goal | Likely PR | Start / Finish / Rollback |
|------|------|-----------|---------------------------|
| 1 | Unique `websaco3CopropiedadId`: index, 409 check, script | PR 1 (`feat/websaco3-id-unico`, base main) | Start: clean main. Finish: tasks 1.1-1.7 green. Rollback: revert + `db.copropiedades.dropIndex('websaco3CopropiedadId_1')` |
| 2 | `common/hmac`, `firmar` delegation, `propietarios.firma`, guard, Joi relax | PR 2a (`feat/websaco3-propietarios-firma`, base main after PR 1) | Finish: 2.1-2.8 green; guard unused by any route. Rollback: revert (nothing consumes it) |
| 3 | Endpoint: DTO, mapper, service, controller, module, contracts, runbook, CLAUDE.md | PR 2b (`feat/websaco3-propietarios-endpoint`, base main after 2a) | Finish: 3.1-3.11 green. Rollback: unset `WEBSACO3_HMAC_SECRET` (401) or delete module + import |
| 4 | Immutable `Inmueble.codigo` backend + frontend field | PR 3 (`feat/inmueble-codigo-inmutable`, base main after 2b) | Finish: 4.1-4.6 green in both repos. Rollback: revert both; no data touched |

Deploy order: gate A -> PR 1 -> PR 2a -> PR 2b -> PR 3 (backend AND `../frontend` deployed together) -> gate D (set `FINANZAS_API_URL` in WebSaco3).

## Manual gates (no code)

- [ ] G.A BEFORE deploying PR 1: run `node scripts/migrate-copropiedad-websaco3-id-index.js --listar`, fix duplicate ids, then run it without the flag to build the index. Boot-time index creation FAILS SILENTLY on duplicates (autoIndex is on in Finanzas), so a green deploy proves nothing.
- [ ] G.B BEFORE deploying PR 2b: confirm `WEBSACO3_HMAC_SECRET` is configured with the same value as WebSaco3 (a missing secret answers 401 by design).
- [ ] G.C `.env.example` is NOT readable by agents: do not touch it; task 3.10 records the exact lines in the runbook and a human appends them.
- [ ] G.D Do NOT set `FINANZAS_API_URL` in WebSaco3 until PR 3 (backend + frontend) is deployed, so a code cannot change between syncs. Also verify at deploy that Cloud Run does not rewrite the request path (D3).
- [ ] G.E PR 3 backend and the frontend read-only field MUST deploy together: the old form resends an editable `codigo`, which now returns 400 if the user changed it.

## Phase 1: PR 1, uniqueness (verify: delegated typecheck/lint/test + script run on a DB copy)

- [x] 1.1 RED `src/modules/copropiedades/copropiedades.service.spec.ts`: free id ok; taken id 409 on create and update; case variant 409; self-update ok; null vs null ok; flag off frees the id; `11000` on the key maps to 409 (Req: websaco3CopropiedadId is unique when set)
- [x] 1.2 GREEN `copropiedades.service.ts`: private `exigirIdWebsaco3Libre(id, excluirId?)` after `aplicarReglaGestionEdificios` in `create`/`update`, trim+lowercase, `exists` with `_id $ne`, Spanish `ConflictException`, map `11000` (D12)
- [x] 1.3 `src/database/schemas/copropiedades/copropiedad.schema.ts`: `index({ websaco3CopropiedadId: 1 }, { unique: true, partialFilterExpression: { websaco3CopropiedadId: { $type: 'string' } } })`; rewrite the "Deliberately not unique" docblock (Req: Index is a partial unique index managed by a script)
- [x] 1.4 Create `scripts/migrate-copropiedad-websaco3-id-index.js` (bootstrap as `migrate-asiento-contable-facturaid-index.js`): group duplicates by `$toLower($trim)`, print ids/codigo/nombre and non-normalized values, exit 1 and no index if any; else idempotent `createIndex` with the schema's name/options; `--listar` lists only (Req: same; scenarios Duplicates present, Clean data)
- [ ] 1.5 Manual on a DB copy: duplicates path exits 1, clean path creates, second run is a no-op (Req: same)
- [x] 1.6 Confirm with a test or comment that boot with duplicates is not blocked and the holders endpoint will answer 409 (Req: same, scenario Application boots with duplicates)
- [x] 1.7 `CLAUDE.md` (backend): update the `websaco3CopropiedadId` row to say unique when set

## Phase 2: PR 2a, signature primitives and guard (verify: delegated; rollback: revert)

- [ ] 2.1 RED `src/common/utils/hmac.spec.ts`: known-answer vector; `hmacHexEquals` false on length mismatch/non-hex, never throws (Req: Signed request authentication)
- [ ] 2.2 GREEN `src/common/utils/hmac.ts`: `hmacSha256Hex`, `hmacHexEquals` (D2)
- [ ] 2.3 `publicacion-facturas.firma.ts`: `firmar` delegates to `hmacSha256Hex(secret, \`${ts}.${body}\`)`; existing spec stays green unchanged (regression proof)
- [ ] 2.4 RED `integraciones-websaco3/propietarios.firma.spec.ts`: `consultaCanonica` order independence, encoding, empty; `cadenaFirmaPropietarios` byte-exact against a literal vector (shared with WebSaco3) (Req: Signed request authentication; scenario Uppercase id signed as sent)
- [ ] 2.5 GREEN `propietarios.firma.ts`: `PROPOSITO`, `VENTANA_SEGUNDOS = 300`, `consultaCanonica`, `cadenaFirmaPropietarios` (D3)
- [ ] 2.6 RED `firma-websaco3.guard.spec.ts`: valid; wrong secret; one digit altered; missing/duplicate/malformed headers; non-numeric ts; +/-300 pass, +/-301 fail; other query/path/trailing slash/HEAD; `${ts}.${body}` signature; secret unset reads nothing; no header values in logs (Req: Signed request authentication; Timestamp window; Fail closed without a secret)
- [ ] 2.7 GREEN `firma-websaco3.guard.ts`: D4 order, single opaque `UnauthorizedException`, reason-only `logger.warn`
- [ ] 2.8 RED/GREEN `src/config/env.validation.ts` + new `env.validation.spec.ts`: `.and(URL, TRIGGER).with(URL, SECRET)`; secret alone boots; URL without secret fails; URL+secret without trigger fails; all three boot; none boots; update the comment (Req: Fail closed without a secret, scenario Only the secret configured)

## Phase 3: PR 2b, endpoint (verify: delegated incl. integration spec; rollback: unset secret or delete module)

- [ ] 3.1 `src/contracts/index.ts`: `PropietariosWebsaco3`, `UnidadPropietarioWebsaco3`, `TitularWebsaco3`
- [ ] 3.2 RED/GREEN `dto/consultar-propietarios.dto.ts` + spec: lowercase transform, `@IsString @Matches(WEBSACO3_COPROPIEDAD_ID_REGEX)`; rejects missing, 23 chars, non-hex, `0x` prefix, repeated, extra param (Req: Query validation)
- [ ] 3.3 RED `propietarios.mapper.spec.ts`: active titular (first of two emails, phone), no titular, unresolved/foreign/inactive titular = null, no email/phone, inactive unit still present (Req: Snapshot content)
- [ ] 3.4 GREEN `propietarios.mapper.ts` (pure, D11)
- [ ] 3.5 RED `propietarios.service.spec.ts` (hand-rolled mocks): 0/1/2 coproperties -> 404/ok/409 with no unit read; flag filter; every filter carries `copropiedadId`; 2000 ok / 2001 -> 422 `demasiadas-unidades` with no tercero read; one `inmuebles.find` + one `terceros.find`; no `TenantContextService` (Req: Coproperty lookup and tenant resolution; Snapshot content; Unit cap)
- [ ] 3.6 GREEN `propietarios.service.ts` (D9, D10; `find` + `limit`, never `findById`)
- [ ] 3.7 `propietarios.controller.ts` (`@Controller('integraciones/websaco3')`, `@Get('propietarios')`, only `FirmaWebsaco3Guard`), `integraciones-websaco3.module.ts` (no imports), register in `src/app.module.ts` (Req: Read-only edge with no domain coupling)
- [ ] 3.8 RED/GREEN integration spec via `configureApp`: envelope `{statusCode,data}`; 401 beats 400; 400 bad/extra/repeated; `X-CoProperty-Id` ignored; model throw = 500; HEAD/trailing-slash replay = 401 (Req: Response envelope and error shape; Tenant header ignored)
- [ ] 3.9 Module removal check: delete the import locally, `npm run typecheck` and tests still pass, then restore (Req: Read-only edge scenario Module removal)
- [ ] 3.10 Create `docs/runbooks/propietarios-websaco3.md`: signed-string layout, shared-vector test, 401/404/409/422 triage, dedup location, rollback, and the "Lines to add to .env.example" section for a human: keep `WEBSACO3_HMAC_SECRET=` and replace its comment with "Shared with WebSaco3. Signs the outbound invoice publication AND authenticates the inbound GET /integraciones/websaco3/propietarios (purpose-bound). May be set alone to enable only the holders endpoint; URL and trigger secret remain all-or-none with each other."
- [ ] 3.11 `CLAUDE.md` (backend): one line on the inbound signed pull

## Phase 4: PR 3, immutable `codigo` (verify: delegated in backend and `../frontend`; rollback: revert both)

- [ ] 4.1 RED `src/modules/inmuebles/inmuebles-escritura.service.spec.ts`: rewrite the two `update`-with-`codigo` duplicate tests (~lines 241, 265); different/case-only -> 400; equal/padded resend ignored and absent from `$set`; omitted ok; foreign unit 404; other fields editable; `create` duplicate still 409; `importar` unchanged (Req: Inmueble.codigo is immutable after creation; Creation and import of new units keep working)
- [ ] 4.2 GREEN `inmuebles.service.ts` `update`: tenant-scoped `findOne({ _id, copropiedadId })` (null = 404), 400 with the Spanish message, drop `codigo` from `$set`, remove the dead duplicate check (D14)
- [ ] 4.3 `dto/guardar-inmueble.dto.ts`: docblock only on `ActualizarInmuebleDto.codigo`
- [ ] 4.4 RED `../frontend/src/pages/inmueble-form.test.tsx`: "Inmueble" disabled with help text on edit, payload carries the stored code; editable and required on create (Req: Frontend code field is read-only on edit)
- [ ] 4.5 GREEN `../frontend/src/pages/inmueble-form.tsx`: `disabled` + `ayuda` when `esEdicion`; `datos.codigo = inmueble.codigo` on edit (D17)
- [ ] 4.6 `CLAUDE.md` (backend): note `Inmueble.codigo` is immutable

## Not planned

- Any change to `importar` or `InmueblesEliminacionService` (accepted by the user, D15). No data migration (D16).
