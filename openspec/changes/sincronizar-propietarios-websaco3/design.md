# Design: Expose unit holders to WebSaco3 (read-only endpoint)

## Technical Approach

A new edge module `integraciones-websaco3` serves `GET /api/v1/integraciones/websaco3/propietarios`. A guard verifies the purpose-bound HMAC, a DTO validates the id, a service finds the `Copropiedad` and reads `Inmueble` + `Tercero` filtered by that `_id`, and a pure mapper builds the contract shape. Nothing is written and no domain module imports it. Two small domain-side changes ride along: a unique index plus a write-time check on `Copropiedad.websaco3CopropiedadId`, and `Inmueble.codigo` immutability. Specs: `specs/websaco3-holders-endpoint`, `specs/copropiedad-websaco3-link`, `specs/inmueble-catalog`.

## Verified in code (facts the decisions rest on)

| # | Fact | Where |
|---|---|---|
| 1 | The HMAC "primitive" is `createHmac('sha256', secret).update(msg,'utf8').digest('hex')`; `firmar` only prepends `${ts}.`. It signs a body, has no verifier (the receiver is WebSaco3) and no path/query/method | `publicacion-facturas.firma.ts` |
| 2 | Joi: `WEBSACO3_HMAC_SECRET` optional, but `.and(URL, SECRET, TRIGGER)` makes the three all-or-none. A secret-only config FAILS boot today. `app.websaco3HmacSecret` already exists in `app.config.ts` | `env.validation.ts:118`, `app.config.ts:27` |
| 3 | Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`), global `TransformInterceptor` (every success becomes `{statusCode, data}`, no opt-out), prefix `api/v1`. Guards run before pipes | `app-setup.ts` |
| 4 | CORS `allowedHeaders` is browser-only; a server-to-server `fetch` sends no `Origin`, so CORS neither applies nor needs the new `X-Websaco-*` headers | `config/cors.ts` |
| 5 | Models `Copropiedad`, `Inmueble`, `Tercero` are global via `@Global DatabaseModule`; a module needs no `imports` (precedent: `PublicacionFacturasModule`) | `database.module.ts` |
| 6 | No `autoIndex:false` anywhere (only the seed script sets it for itself) and no `syncIndexes()`: Mongoose builds indexes on boot. Precedent script only DROPS a conflicting index and relies on boot to recreate it. `copropiedades` is a tiny collection | `asiento-contable.schema.ts:178`, `scripts/migrate-asiento-contable-facturaid-index.js` |
| 7 | `Inmueble.codigo` write paths: `create` (line 166), `update` via `aDocumento` `set('codigo')` (line 554), `importar` (`inmuebles.create`, line 304). `importar` has NO update path: it first runs `eliminarTodosEliminables` (deletes every unit without a Factura, billed ones survive) and then creates rows; a repeated code of a surviving unit fails that row via `filtroCodigoDuplicado`. `seed-demo` uses `$setOnInsert` only. **[2026-10-21: the "NO update path" part is REVERSED by `importar-inmuebles-upsert`. `importar` now matches by code, patches existing units and never deletes; the wipe (`eliminarTodosEliminables`) is gone. Reason: the wipe is non-atomic, can orphan non-invoice financial records (Recibo, SaldoInicial, notas and SaldoCartera also reference `inmuebleId`) and blocks correcting invoiced units. `codigo` is still never written on update.]** | `inmuebles.service.ts`, `inmuebles-eliminacion.service.ts` |
| 8 | Frontend edit form always sends `codigo: campos.codigo.trim()`; `Field` accepts `disabled` and `ayuda` | `inmueble-form.tsx:283,347`, `ui/field.tsx` |
| 9 | Boot-time index creation fails silently (per the repo's own note) when data violates the index, so a duplicate id would NOT stop deploys | `asiento-contable.schema.ts:178-187` |

## Architecture Decisions

| # | Topic | Choice | Rejected | Why |
|---|---|---|---|---|
| D1 | Module | New `modules/integraciones-websaco3/` (no `imports`), registered in `app.module.ts` after `PublicacionFacturasModule`. Inbound pull stays apart from the outbound `publicacion-facturas` | Add the route to `publicacion-facturas` | Different direction, guard and lifecycle; deleting either leaves the other compiling (CLAUDE.md "stands alone" test) |
| D2 | Shared primitive | `src/common/utils/hmac.ts` exports `hmacSha256Hex(secret, message)` and `hmacHexEquals(expectedHex, receivedHex)` (timing-safe over 32-byte buffers; false on any length/format mismatch, never throws). `firmar` becomes `hmacSha256Hex(secret, \`${ts}.${body}\`)`; its existing spec stays green and is the regression proof | New module imports `firmar` from `publicacion-facturas`; copy-paste | Edge-to-edge coupling would break independent removal; `common/` is where shared infra belongs |
| D3 | Signed string | `propietarios.v1\n${ts}\n${request.method}\n${path}\n${sortedQuery}` where `path` is the pathname of `request.originalUrl` (full, including `/api/v1`, raw as received, no trailing-slash normalization) and `sortedQuery` is built from the raw query string: `URLSearchParams` pairs, sorted by key then value, `encodeURIComponent` each, joined `k=v&...`, empty string if none. Built in `propietarios.firma.ts` (`consultaCanonica`, `cadenaFirmaPropietarios`) | Signing the DTO-validated/lowercased value; `req.path`; `req.query` object | Signature must cover exactly what the caller sent (uppercase id included); `originalUrl` keeps the prefix; the method is the received one so `HEAD` (which Express routes to GET handlers) cannot reuse a GET signature |
| D4 | Verification order in the guard | (1) secret set else 401; (2) both headers present as single strings; (3) `ts` matches `^\d{1,12}$` and `abs(nowSec - ts) <= 300`; (4) signature matches `^sha256=[0-9a-f]{64}$`; (5) `hmacHexEquals`. Every failure: identical `UnauthorizedException()`, `logger.warn` with the reason only (never header values/secret). Same fail-closed pattern as `SecretoProgramadorGuard` | Distinct 401 messages; 403 | A probe must not learn which check failed |
| D5 | Secret and Joi | Reuse `WEBSACO3_HMAC_SECRET` read as `app.websaco3HmacSecret`. RELAX Joi: replace `.and(URL, SECRET, TRIGGER)` with `.and(URL, TRIGGER).with(URL, SECRET)`. Secret alone becomes valid; any outbound-publication setting still drags the full set (strictly a superset of today's valid configs, so no existing deployment breaks). New `env.validation.spec.ts` cases cover it | Keep the three-way `.and` (pull would require an unused outbound URL and trigger secret, against backend rule 2); new secret (user decided: reuse) | Pull-only is a legitimate deployment. The cross-use risk (same key signs both directions) is contained by the purpose prefix and the receiver verifying the prefix, which `${ts}.${body}` signatures can never produce |
| D6 | Auth model | Controller carries ONLY the new guard. No `FirebaseAuthGuard`, `PoliciesGuard`, `@CheckAbility`, `TenantContextService` (the service takes the coproperty `_id` as a parameter and never injects the tenant context or reads `X-CoProperty-Id`) | Reuse the Firebase flow | Machine-to-machine, no user, no CLS tenant: the tenant IS the looked-up coproperty, so the tenancy law is satisfied by construction (every filter carries that `_id`). Same reasoning as `PublicacionFacturasController` |
| D7 | Query DTO | `dto/consultar-propietarios.dto.ts`: `@Transform(({value}) => typeof value === 'string' ? value.toLowerCase() : value) @IsString() @Matches(WEBSACO3_COPROPIEDAD_ID_REGEX)`. Repeated params become arrays (fail `@IsString`), extras fail `forbidNonWhitelisted`. Guard runs first, so unsigned callers get 401 even for malformed ids | `@IsMongoId` (accepts `0x`/`0h` prefix); trimming the value | One shared regex across layers; strictness (whitespace is 400) matches the signed value |
| D8 | Response shape | Follow the envelope: wire body is `{ statusCode: 200, data: { copropiedad: { nombre }, unidades: [...] } }`. The contract's "Response" row describes `data`. WebSaco3's client MUST read `.data` | `@Res()` bypass or a skip decorator | Backend rule 7 and the global interceptor make the envelope unconditional; bypassing adds machinery for one consumer we control. The WebSaco3 side adopts the envelope (user decision, see Open Questions) |
| D9 | Lookup | `copropiedades.find({ websaco3CopropiedadId: idLower, usaGestionEdificios: true }).select('_id nombre').limit(2).lean()`: 0 -> 404, 2 -> 409, 1 -> proceed. `estado` is not filtered (contract: id + flag only) | `findOne` (cannot detect duplicates); filtering inactive coproperties | Contract wording; the unique index makes 409 a legacy-data-only case |
| D10 | Reads and cap | `inmuebles.find({ copropiedadId }).select('codigo titularId tipoTitular').sort({ codigo: 1 }).limit(2001).lean()`; if length > 2000 -> `UnprocessableEntityException({ statusCode: 422, error: 'demasiadas-unidades', message })` before touching terceros. Then ONE `terceros.find({ copropiedadId, _id: { $in: distinctTitularIds }, estado: 'active' }).select('nombre emails telefono').lean()` into a `Map`. Never `findById` on tenant data | Per-unit `populate`; `countDocuments` + find; paginating | Two queries for 2000 units, bounded memory; `limit(2001)` detects overflow without loading more; the `$in` + `copropiedadId` filter makes a foreign-tenant `titularId` simply unresolved |
| D11 | Mapper (pure, `propietarios.mapper.ts`, shape in `contracts/index.ts`) | `tipo = Inmueble.tipoTitular`. `titular` = null when `titularId` is null, unresolved, other tenant, or `Tercero.estado === 'inactive'`; else `{ nombre, email: first non-empty trimmed of emails else null, telefono: trimmed telefono or null }`. All units included regardless of `Inmueble.estado` | Include inactive titular; drop inactive units; lowercase the email | An inactive Tercero is a retired party, not a current holder, so WebSaco3 removes managed access (consistent with its "holder changed -> remove" rule); the contract says one entry per Inmueble; email normalization is WebSaco3's job (it owns Account matching) |
| D12 | Uniqueness | Schema: `CopropiedadSchema.index({ websaco3CopropiedadId: 1 }, { unique: true, partialFilterExpression: { websaco3CopropiedadId: { $type: 'string' } } })`; default name `websaco3CopropiedadId_1`; docblock "Deliberately not unique" rewritten. Service: private `exigirIdWebsaco3Libre(id, excluirId?)` called after `aplicarReglaGestionEdificios` in `create` and `update`; normalizes with trim + lowercase explicitly (does not rely on schema setters running on `$set`); `exists({ websaco3CopropiedadId: id, _id: { $ne } })` -> `ConflictException`; also maps a Mongo `11000` on that key (race) to the same 409 | Unique sparse index; application check only; index only | `$type:'string'` ignores null/absent so many unlinked coproperties coexist; check gives a sentence, index closes the race |
| D13 | Index management | `scripts/migrate-copropiedad-websaco3-id-index.js` (same bootstrap as the precedent: `dns.setServers`, dotenv, `mongoose.mongo.MongoClient`). Steps: aggregate duplicates by `$toLower($trim)`, print groups (ids, codigo, nombre) plus non-normalized values; if any duplicate -> exit 1 without creating; else `createIndex` with the schema's exact name and options (idempotent; `IndexOptionsConflict` 85/86 reported). `--listar` flag lists only. Run BEFORE deploying PR 1. Answer to proposal Q1: autoIndex is ON in production (fact 6), but boot-time failure is silent (fact 9), so the script is the visible gate and also builds the index deterministically | Rely on boot; drop-and-recreate like the precedent | Duplicates must be seen and fixed by a human first; with same name+options boot-time creation is a no-op |
| D14 | Immutable `codigo` | `InmueblesService.update`: tenant-scoped `findOne({ _id: id, copropiedadId }).select('codigo').lean()` (null -> 404); if `dto.codigo !== undefined` and `dto.codigo.trim() !== stored.codigo` -> `BadRequestException('El código de un inmueble no se puede modificar después de crearlo.')`; `codigo` is deleted from the `$set` (unchanged resend ignored). Remove the now-dead duplicate check in `update`. `ActualizarInmuebleDto.codigo` stays optional (so our message, not "property should not exist", reaches the form). HTTP 400 follows the repo's rule-violation convention (`aplicarReglaGestionEdificios`); 409 stays for duplicates | Drop `codigo` from the update DTO (generic 400 from `forbidNonWhitelisted`, breaks a form that resends it); 422; block the import | Smallest change that keeps old clients working and shows a clear message beside the field |
| D15 | Import | No code change in `importar` or `InmueblesEliminacionService`. It cannot rename in place; the only "code change" path is delete + recreate of units WITHOUT a Factura (new `_id`), which is the existing replace-the-roster contract. Billed units are protected by the existing guard | Forbid importing over unbilled units; match-by-code upsert | Keeps the Excel flow intact (user requirement). Effect on WebSaco3: a vanished code is "absent from snapshot" and a new code a new unit, so the next sync converges. Confirmed by the user (see Open Questions). **[2026-10-21: REVERSED by `importar-inmuebles-upsert`. "No code change in `importar`" and "match-by-code upsert REJECTED" no longer hold: `importar` is now an upsert by code that never deletes and never writes `codigo` (so D14's immutability is preserved), and units keep their `_id` across imports. Reason: the wipe is non-atomic, can orphan non-invoice financial records and blocks correcting invoiced units. A vanished code can no longer happen through an import, which only makes the WebSaco3 sync more stable.]** |
| D16 | Existing data | No migration: nothing to backfill; stored codes stay as they are | n/a | Immutability is forward-only |
| D17 | Frontend | `inmueble-form.tsx`: when `esEdicion`, the "Inmueble" `Field` gets `disabled` and `ayuda="El código no se puede modificar después de crear el inmueble."`; `datos.codigo` is `inmueble.codigo` on edit, `campos.codigo.trim()` on create. Update `inmueble-form.test.tsx` | `readOnly` (no read-only style in `CLASES_CAJA_CAMPO`) | `disabled` already has the `bg-muted` style (no opacity dimming, per frontend rule 11) |

## Data Flow

```
WebSaco3 ──GET + X-Websaco-Timestamp/Signature──> Cloud Run
  FirmaWebsaco3Guard   (secret? headers? |now-ts|<=300? hmacHexEquals)  ──fail──> 401 (opaque)
  ValidationPipe+DTO   (lowercase, strict 24-hex, no extras)            ──fail──> 400
  PropietariosService
     copropiedades.find(id, flag on).limit(2)   0->404  2->409
     inmuebles.find({copropiedadId}).limit(2001) >2000 -> 422 demasiadas-unidades
     terceros.find({copropiedadId, _id:$in, active})   (one query)
  mapper (pure) ──> TransformInterceptor ──> { statusCode:200, data:{copropiedad,unidades} }
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/common/utils/hmac.ts` (+ `hmac.spec.ts`) | Create | `hmacSha256Hex`, `hmacHexEquals` |
| `src/modules/publicacion-facturas/publicacion-facturas.firma.ts` | Modify | Delegate to `hmacSha256Hex`; output identical |
| `src/modules/integraciones-websaco3/integraciones-websaco3.module.ts` | Create | Controller + service + guard, no imports |
| `.../propietarios.controller.ts` | Create | `@Controller('integraciones/websaco3')`, `@Get('propietarios')`, `@UseGuards(FirmaWebsaco3Guard)`, returns the contract type |
| `.../firma-websaco3.guard.ts` | Create | D4 |
| `.../propietarios.firma.ts` | Create | `consultaCanonica`, `cadenaFirmaPropietarios`, constants (`PROPOSITO`, `VENTANA_SEGUNDOS = 300`) |
| `.../propietarios.service.ts` | Create | D9, D10 |
| `.../propietarios.mapper.ts` | Create | D11 |
| `.../dto/consultar-propietarios.dto.ts` | Create | D7 |
| `.../*.spec.ts` | Create | See Testing |
| `src/contracts/index.ts` | Modify | `PropietariosWebsaco3`, `UnidadPropietarioWebsaco3`, `TitularWebsaco3` |
| `src/app.module.ts` | Modify | Register the module |
| `src/config/env.validation.ts` (+ spec) | Modify | D5 and a comment update |
| `src/database/schemas/copropiedades/copropiedad.schema.ts` | Modify | D12 index and docblock |
| `src/modules/copropiedades/copropiedades.service.ts` (+ spec) | Modify | D12 check and 409 mapping |
| `scripts/migrate-copropiedad-websaco3-id-index.js` | Create | D13 |
| `src/modules/inmuebles/inmuebles.service.ts` (+ `inmuebles-escritura.service.spec.ts`) | Modify | D14; the two existing `update`-with-`codigo` duplicate tests (lines ~241 and ~265) are rewritten |
| `src/modules/inmuebles/dto/guardar-inmueble.dto.ts` | Modify | Docblock on `ActualizarInmuebleDto.codigo` only |
| `frontend/src/pages/inmueble-form.tsx` (+ test) | Modify | D17 |
| `docs/runbooks/propietarios-websaco3.md` | Create | See Rollout |
| `CLAUDE.md` (backend) | Modify | One line: the integration serves data to the other system over an inbound signed pull; `Inmueble.codigo` immutable |

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `hmac.ts`; `firmar` unchanged vector | Known-answer vectors; length-mismatch and non-hex return false |
| Unit | `propietarios.firma.ts` | Canonical query: order independence, encoding, empty; string layout byte-exact against a literal expected vector SHARED with WebSaco3's test |
| Unit | Guard | Valid; wrong secret; one-digit change; missing/duplicate/malformed headers; ts non-numeric, +/-300 ok, +/-301 rejected; other query/path/method (HEAD)/trailing slash; `${ts}.${body}` style signature; secret unset; uppercase id signed as sent; no header value in logs |
| Unit | Service + mapper (hand-rolled model mocks) | 0/1/2 coproperties; flag filter; every query carries `copropiedadId`; 2000 ok / 2001 -> 422 with no tercero read; one `inmuebles.find` and one `terceros.find` for N units; titular cases (null, foreign, inactive, no email, second email, phone); no `TenantContextService` dependency |
| Integration | Real HTTP app via `configureApp` (pattern of `app-setup` spec) | Envelope `{statusCode,data}`; 401 beats 400; 400 for bad/extra/repeated params; `X-CoProperty-Id` ignored; 5xx on model throw |
| Unit | `CopropiedadesService` | Free id; taken id (create and update); case variant; self-update; null vs null; flag off frees; E11000 -> 409 |
| Unit | Joi | Secret only boots; URL without secret fails; URL+secret without trigger fails; all three boots; none boots |
| Unit | `InmueblesService.update` | Different/case-only -> 400; equal/padded resend ignored and absent from `$set`; omitted ok; foreign unit 404; `create` dup still 409; `importar` unchanged |
| Frontend | `inmueble-form.test.tsx` | Disabled + help on edit; enabled on create; payload carries stored code |
| Manual | Script | Against a copy: duplicates path (exit 1), clean path, second run no-op |

## Migration / Rollout

Order (stacked-to-main, 3 PRs): merge 1 -> 2 -> 3. Deploy gates:
1. Before deploying PR 1: run `node scripts/migrate-copropiedad-websaco3-id-index.js --listar`; fix duplicates by editing the coproperty ids; run without `--listar` to build the index.
2. PR 2 is inert until WebSaco3 calls it. WebSaco3 enabling is controlled by ITS `FINANZAS_API_URL`. `WEBSACO3_HMAC_SECRET` must hold the same value on both sides (it already does if publication is on); no new secret.
3. Do not set WebSaco3's `FINANZAS_API_URL` until PR 3 is deployed, so a code can no longer be edited between syncs.

`.env.example` (not readable by agents; to be edited by hand in PR 2): keep `WEBSACO3_HMAC_SECRET=` and replace the comment above it with: "Shared with WebSaco3. Signs the outbound invoice publication AND authenticates the inbound GET /integraciones/websaco3/propietarios (purpose-bound). May be set alone to enable only the holders endpoint; URL and trigger secret remain all-or-none with each other." No new variable. The runbook repeats these lines plus: the signed-string layout, the `curl`-free test via the shared vector, the 401/404/409/422 triage table, and "where the dedup lives".

Rollback: PR 2 -> unset `WEBSACO3_HMAC_SECRET` (route answers 401) or delete the module and its import; the contract types are inert. PR 1 -> `db.copropiedades.dropIndex('websaco3CopropiedadId_1')` and revert the check. PR 3 -> revert; no data was touched.

PR slicing (additions + deletions, tests included): **PR 1 ~250** (schema, service check, script, spec). **PR 2 ~500, at risk of overflow** (about 220 prod + 280 tests): if it passes 500, split at the natural seam into 2a `common/hmac` + `firma` + guard + Joi + their tests (~280) and 2b controller/service/mapper/DTO/module/contracts/runbook + tests (~300). **PR 3 ~150** (service, DTO docblock, frontend field, tests, CLAUDE.md line).

## Open Questions

- [x] User DECIDED: inactive `Tercero` titular maps to `titular: null` (D11). No change.
- [x] User DECIDED: `Inmueble.estado = 'inactive'` units ARE included in the snapshot. No change.
- [x] User DECIDED: the Excel import may keep deleting and recreating never-billed units (code survives, `_id` changes) (D15). Accepted; no change to `importar`. **[2026-10-21: superseded. The import no longer deletes anything; see D15 and `importar-inmuebles-upsert`.]**
- [x] User DECIDED (informational, no Finanzas change): the WebSaco3 side adopts (a) the `{ statusCode, data }` envelope and reads `.data`; (b) the exact `sortedQuery` canonicalization in D3 and the shared test vector; (c) signing `request.method` and the FULL path with `/api/v1`.
- [ ] Verify at deploy: Cloud Run does not rewrite the request path (D3 uses `originalUrl` as received).
