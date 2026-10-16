# Proposal: Expose unit holders to WebSaco3 (read-only endpoint)

> `artifact_store.mode`: openspec · phase: sdd-propose · counterpart: WEBSACO3 `recibir-propietarios-finanzas` (supersedes the event/outbox/push design)

## Intent

WebSaco3 residents are typed by hand while Finanzas already knows who holds each unit. WebSaco3 will PULL the current holders of one coproperty on demand. Finanzas only exposes a read-only edge endpoint; its domain stays unaware of WebSaco3.

## Scope

### In Scope
- Edge module `integraciones-websaco3`: the route below, HMAC guard, mapper (pure functions, `contracts/index.ts` shape).
- Partial unique index on `Copropiedad.websaco3CopropiedadId` (non-null) plus a write-time uniqueness check in `CopropiedadesService` (409).
- Env: reuses the existing `WEBSACO3_HMAC_SECRET` (no new secret); runbook.
- `Inmueble.codigo` becomes IMMUTABLE after creation (user decision): service/DTO reject changes with a clear 4xx, the form field is read-only on edit; creation and the Excel import of new rows keep working, and the import must never rename an existing inmueble.

### Out of Scope
Automatic/scheduled/push sync, events, outbox, owners Excel export, deleting Accounts/Firebase users, unit catalog, any change to terceros services (inmuebles only to make `codigo` immutable).

## Contract (shared, identical in both proposals)

| Item | Value |
|------|-------|
| Route | `GET /api/v1/integraciones/websaco3/propietarios?websaco3CopropiedadId=<24hex>` (WebSaco3 → Finanzas, pull) |
| Auth | HMAC, not Firebase/CASL. `X-Websaco-Timestamp` (±300 s), `X-Websaco-Signature: sha256=hex(HMAC(secret, "propietarios.v1\n${ts}\nGET\n${path}\n${sortedQuery}"))`; purpose, method, path and query are signed. Secret: the existing shared `WEBSACO3_HMAC_SECRET` (same value on both sides; the signed purpose string keeps a signature from working in the other direction) |
| Lookup | `Copropiedad` with that id and `usaGestionEdificios` on; tenant = its `_id`, never a header. None → 404; several → 409 |
| Response | `{ copropiedad:{nombre}, unidades:[{ codigo, tipo:'propietario'\|'arrendatario', titular:{ nombre, email\|null, telefono\|null }\|null }] }`: one entry per `Inmueble`, complete current snapshot, `titular:null` when none; >2000 units → 422 `demasiadas-unidades` |
| Errors | 400 bad query · 401 signature/timestamp · 404 · 409 · 422 terminal; 5xx retryable |
| Key | `normalizeUnitCode(codigo)` on both sides; email only finds/creates the Account |
| Managed entries | `Membership.units` entry marked `managedBy:'finanzas'`; `propietario→owners`, `arrendatario→tenants` |
| Removal | Marked unit absent from the snapshot, or whose holder changed/has no email, is removed from its holder; Membership without units → inactive; never Account/Firebase user |
| Never touched | Unmarked units, staff, co-residents |

## Capabilities

### New Capabilities
- `websaco3-holders-endpoint`: signed read-only holders snapshot per coproperty.

### Modified Capabilities
- `copropiedad-websaco3-link`: `websaco3CopropiedadId` becomes unique when set.
- `inmueble-catalog`: `codigo` immutable after creation.

## Approach

Controller (HMAC guard, DTO query validation, lowercase id) → find coproperty → read `Inmueble` + `Tercero` filtered by that `_id` → mapper. Reuses the signing helper of `publicacion-facturas` (extract the shared HMAC primitive, add the purpose-bound string). Secret: reuses `WEBSACO3_HMAC_SECRET` (user decision, no extra secrets); the purpose-bound string (prefix, method, path, query) prevents cross-use. Accepted trade-off: that key now also authorizes reading holder PII. Index precedent: `scripts/migrate-asiento-contable-facturaid-index.js`; the script lists duplicates first, then creates the index (do not rely on boot-time autoIndex).

## Affected Areas

| Area | Impact |
|------|--------|
| `src/modules/integraciones-websaco3/` | New |
| `src/database/schemas/copropiedades/copropiedad.schema.ts` | Modified (partial unique index) |
| `src/modules/copropiedades/` | Modified (409 on duplicate id) |
| `src/modules/inmuebles/` + frontend inmueble form | Modified (`codigo` immutable) |
| `src/modules/publicacion-facturas/*.firma.ts` | Modified (shared primitive) |
| `src/config/env.validation.ts`, `scripts/`, `docs/runbooks/` | Modified/New |

## Risks

| Risk | Mitigation |
|------|------------|
| Existing duplicate ids block the index | Script reports them first; fix data, then index |
| Holder PII to a wrong caller | Purpose-bound signature, shared secret kept like the lotes one, ±300 s window |
| Replay within window | Read-only, same data |
| Mistyped id leaks another building | WebSaco3 name header check |
| Renames of `Inmueble.codigo` | `codigo` immutable (decided); creation and import of new rows keep working |
| Building >2000 units | Explicit 422 |

## Rollback Plan

Unset the secret (route answers 401/disabled) or remove the module; drop the index. No data written.

## Success Criteria

- [ ] Valid signature returns one entry per `Inmueble`, scoped by the looked-up coproperty.
- [ ] Signature replayed on another query/path/direction fails 401.
- [ ] Unknown id 404; duplicated id 409; flag off 404.
- [ ] Removing the module leaves everything else compiling.

## Open Questions

1. Is boot-time autoIndex on or off in production?
2. Does the inmuebles Excel import ever overwrite the code of an existing inmueble (it must be rejected or ignored)?

Decided with the user: `codigo` immutable; the 2000-unit cap is enough; reuse `WEBSACO3_HMAC_SECRET`.

## Review Workload (stacked-to-main)

| PR | Content | Lines |
|----|---------|-------|
| 1 | Index, script, write-time uniqueness, tests | ~250 |
| 2 | Endpoint, guard, mapper, env, runbook, tests | ~500 |
| 3 | Immutable `codigo`: service, DTO, form field, tests | ~150 |
