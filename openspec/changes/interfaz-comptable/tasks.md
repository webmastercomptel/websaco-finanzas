# Tasks: "Interfaz a Comptable" — manual, signed push of asientos to Comptable

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,900 total (PR 1 ~350, PR 2 ~250, PR 3 ~300, PR 4 ~550, PR 5 ~450) |
| 400-line budget risk | High as a single PR; Medium per slice (PR 4 above budget, accepted size exception) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 `comptableEmpresaId` + client → PR 2 extract shared resolution → PR 3 schemas + payload builder → PR 4 service/endpoints → PR 5 frontend |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

Local branches only, NO push, NO deploy. Paths under `backend/` unless noted. Test-first (RED then GREEN). Verify each PR with `npm run typecheck && npm run lint && npm test` (frontend: `npm run lint && npm test && npm run build`), delegated.

| Unit | Goal | Likely PR | Start / Finish / Rollback |
|------|------|-----------|---------------------------|
| 1 | Config, signed client, `Copropiedad.comptableEmpresaId` (index, 409, remote validation, script) + form field | PR 1 (`feat/comptable-empresa-id`) | Finish: 1.x green. Rollback: revert + `dropIndex('comptableEmpresaId_1')` |
| 2 | Extract anchor/concepto/saldo-inicial resolution out of `AdicionContabilidadService` — no behavior change | PR 2 (`refactor/resolucion-documentos-contables`) | Finish: CSV suite green untouched. Rollback: revert |
| 3 | `LoteComptable`, stamps on `AsientoContable`, pure payload builder v1 | PR 3 (`feat/interfaz-comptable-payload`) | Finish: 3.x green; nothing calls it yet. Rollback: revert |
| 4 | Module `interfaz-comptable`: permission, preview, simular, enviar/reintentar, retirar, lotes, audit | PR 4 (`feat/interfaz-comptable-envio`) | Finish: 4.x green. Rollback: unset `COMPTABLE_API_URL` (screen says not configured) |
| 5 | Frontend page `interfaz-comptable` + navigation/permissions | PR 5 (`feat/interfaz-comptable-pantalla`, `../frontend`) | Finish: 5.x green. Rollback: revert |

Deploy order: Comptable plan fully deployed (gate A) → PR 1 … PR 5 → gate C.

## Manual gates (no code)

- [ ] G.A Comptable's `2026-10-21-integracion-websaco-finanzas` plan is deployed, `seed:cuenta-integracion` was run, and its `GET integraciones/websaco/empresas/:id` answers 401 unsigned.
- [ ] G.B BEFORE deploying PR 1: `node scripts/migrate-copropiedad-comptable-id-index.js --listar`, then without the flag (autoIndex fails silently on duplicates — same lesson as `websaco3CopropiedadId`).
- [ ] G.C `.env.example` is NOT readable by agents: task 1.1 writes the exact lines in the runbook and a human appends them. Set `COMPTABLE_API_URL` and `COMPTABLE_HMAC_SECRET` (same value as Comptable) per environment.
- [ ] G.D First real send: copropiedad of test, "Ver JSON" reviewed by the owner, "Simular" clean, then "Enviar".

## Phase 1: PR 1 — config, client, Empresa mapping

- [x] 1.1 Joi: `COMPTABLE_API_URL` (uri, optional) and `COMPTABLE_HMAC_SECRET` (min 32, optional), `.and()`-paired; `app.config.ts`; runbook `docs/runbooks/interfaz-comptable.md` with the `.env.example` lines, secret generation, rotation. Spec: either alone fails boot; neither boots.
- [x] 1.2 `modules/interfaz-comptable/comptable.firma.ts`: `cadenaFirma({ timestamp, metodo, ruta, rawBody })` = `${ts}.${METHOD}.${path}.${rawBody}`, built on `common/utils/hmac.ts`. Copy Comptable's `test/fixtures/websaco-finanzas/` vector and payload; spec: same signature byte for byte.
- [x] 1.3 `ComptableClient`: `consultarEmpresa(id)`, `enviarLote(empresaId, rawBody, simular)`, `retirarLote(empresaId, loteOrigenId)`. Body serialized ONCE and signed+sent unchanged; headers `X-Websaco-Timestamp`, `X-Websaco-Signature: sha256=<hex>`; `AbortController` 60 s. Typed outcomes: `ok | rechazado(errores) | duplicado(loteId) | intervenido(mensaje) | firma | timeout | red | noConfigurado`. Specs with mocked `fetch` for every outcome; never logs body, secret or signature.
- [x] 1.4 `Copropiedad.comptableEmpresaId: string | null`, partial unique index (`$type: 'string'`), `scripts/migrate-copropiedad-comptable-id-index.js` (`--listar` mode), mirror of the websaco3 pair.
- [x] 1.5 `CopropiedadesService` create/update: 24-hex format (400), duplicate in another copropiedad (409), `consultarEmpresa` 404 → 422 "No existe esa Empresa en Comptable", unreachable/not configured → 502 and nothing saved. Only checked when the value changes.
- [ ] 1.6 `contracts/index.ts` + DTOs; `../frontend` `copropiedad-form.tsx`: field "Id de la Empresa en Comptable" with the error messages above. Tests on both sides. _(backend half done: contract + DTO + specs; frontend form pending)_

## Phase 2: PR 2 — shared resolution, no behavior change

- [ ] 2.1 Move `buildAnchorMap`, `resolveConceptos`, `resolverSaldosInicialesPorNumero` usage and `tipoDocumentoDe` into `modules/adicion-contabilidad/resolucion-documentos.service.ts` (exported provider). `AdicionContabilidadService` delegates to it.
- [ ] 2.2 The whole `adicion-contabilidad.service.spec.ts` passes with no assertion changed; the generated CSVs of a fixture lote are byte-identical before/after.

## Phase 3: PR 3 — schemas and payload builder

- [ ] 3.1 `LoteComptable` (`lotes_comptable`): copropiedadId, number (own `ConsecutivoLoteComptable`), periodStart/End, asientoIds, totals, estado `pendiente | enviado | fallido | retirado`, motivoFallo, comptableLoteId, intervenidoMensaje, sentBy/Nombre, retiradoPor/fecha. English persistence + mapper, as the rest of Finanzas.
- [ ] 3.2 `AsientoContable.comptableLoteId` + `comptableLoteRetiradoId` (default null), index `{ copropiedadId, comptableLoteId }`. Independent from `contabilidadLoteId`: specs prove a CSV generation ignores Comptable stamps and vice versa.
- [ ] 3.3 `construirPayloadComptable(asientos, resolucion, titulares, origen)` — pure, contract v1:
  - documento = `tipoDocumentoDe`, `prefijo`/`numero` from the anchor's own fields (never `documentoCruce`).
  - `descripcion` = resolved concepto; line `detalle` = same as MOVMESDO's.
  - Montos as `toFixed(2)` strings from integer cents; débito/crédito exclusive.
  - `tercero`: identificación = `Movimiento.tercero` (inmueble code); data from the inmueble's titular `Tercero` (tipoPersona, nombres/apellidos or razón social, tipo/número id, DV, email, teléfono, dirección, ciudad).
  - `centroUtilidad` = `centroCosto`, `centroDestino` = null, `flujoCaja`, `baseGravable`, `tipoDocCruce`/`numeroDocCruce` (Saldo Inicial → original number, as the CSV).
- [ ] 3.4 `inmueblesSinTitular(asientos)` — list of codes whose inmueble has no titular (blocks the send).
- [ ] 3.5 Spec: builder output for the shared fixture equals Comptable's fixture JSON exactly; each document type; prefix "" vs "FEVP"; balance per asiento.

## Phase 4: PR 4 — module, endpoints, flow

- [ ] 4.1 Permission: module key `interfaz-comptable` → new subject `InterfazComptable` in `permission-map.ts` (read/create/annul), frontend `permisos.ts`. Spec: `adicion-contabilidad` grants nothing here and vice versa.
- [ ] 4.2 `GET interfaz-comptable/pendientes`: requires `comptableEmpresaId` (else 409 "Esta copropiedad no tiene Empresa de Comptable configurada"); counts per tipo, totals, `inmueblesSinTitular`, and the exact JSON (debug preview). Same selection as MOVMES: last consolidated period, `comptableLoteId: null`, or released by a retiro.
- [ ] 4.3 `POST interfaz-comptable/simular`: builds and sends with `simular=true`; returns Comptable's summary or its `errores[]` verbatim; writes nothing locally.
- [ ] 4.4 `POST interfaz-comptable/enviar`: 409 if a lote is `pendiente` (must "Reintentar") or there are inmuebles sin titular; transaction creates `LoteComptable` `pendiente` with its asientoIds; send outside it; then:
  - ok / duplicado → stamp `comptableLoteId`, estado `enviado`, `comptableLoteId` saved, audit;
  - rechazado / firma → `fallido` + motivo, nothing stamped;
  - timeout / red → stays `pendiente`.
- [ ] 4.5 `POST interfaz-comptable/lotes/:id/reintentar`: only `pendiente`; rebuilds the payload from the SAME asientoIds and SAME `loteOrigenId`; same outcome handling.
- [ ] 4.6 `POST interfaz-comptable/lotes/:id/retirar`: only `enviado`; calls Comptable first; ok → release stamps (`comptableLoteId: null`, `comptableLoteRetiradoId: lote`), estado `retirado`, audit; `intervenido` → 409 with Comptable's message verbatim, saved in `intervenidoMensaje`, lote stays `enviado`.
- [ ] 4.7 `GET interfaz-comptable/lotes`: history, tenant-scoped (`findOne({ _id, copropiedadId })`, never `findById`).
- [ ] 4.8 Audit entries (`entidadTipo: 'lote-comptable'`) for enviar, retirar and failures, labelled with the coproperty as the CSV lotes.
- [ ] 4.9 Specs: each endpoint × each client outcome; concurrency (two "Enviar" at once → one lote); tenancy; a CSV generation in between changes nothing.

## Phase 5: PR 5 — frontend (`../frontend`)

- [ ] 5.1 `pages/interfaz-comptable.tsx` + `lib/api/interfaz-comptable.ts`, nav entry, lazy page, permission gate.
- [ ] 5.2 States: not configured / no Empresa → message, no buttons; pending summary (values `1,500,000.25`); inmuebles sin titular listed and "Enviar" disabled; "Ver JSON" (collapsible, copy button — debug aid); "Simular" shows Comptable's summary or its errors table; "Enviar"; lote `pendiente` → only "Reintentar" with an explanation.
- [ ] 5.3 History: número, período, documentos, totales, estado, fechas `dd/mm/yyyy hh:mm`; "Retirar" with confirmation ("Se eliminarán en Comptable los N asientos de este lote"); intervenido → its message, no button.
- [ ] 5.4 Tests for every state above; Spanish (Colombia, tú) texts.
