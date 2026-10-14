# Proposal: Link invoice publication to WebSaco3 by `_id`

## Intent

The publisher links a coproperty to WebSaco3 by NIT. That match is ambiguous on the WebSaco3 side. The user decided to link **only** by WebSaco3's Mongo `_id`. NIT leaves this integration entirely. There is also a second problem: nothing calls `POST /api/v1/interno/publicacion-facturas/procesar-pendientes`, so every outbox row stays `pendiente` forever. Today, nothing ever gets published.

## Scope

### In Scope
- New `Copropiedad.websaco3CopropiedadId` (24-hex ObjectId string) across the schema, DTO (`@Matches(/^[0-9a-f]{24}$/i)`, not `@IsMongoId()`, which accepts a `0x`/`0h` prefix), contract, mapper and service.
- Validation rules for the new id:
  - It is required iff `usaGestionEdificios` is on. Turning the flag off clears it.
  - It replaces the NIT+DV activation requirement.
- Frontend: an input that shows only while the checkbox is on.
  - Helper text: "Copiá el ID desde WebSaco3 > Configuración > Copropiedades > Ver detalle". UI copy is Spanish with voseo, matching existing pages.
  - Client-side format check.
- Publisher:
  - The payload sends `websaco3CopropiedadId` instead of `nit`.
  - `encolar` warns and skips when the flag is on but the id is missing.
- Legacy outbox rows that hold a NIT snapshot and no id (see Approach).
- A fix for the missing trigger: immediate dispatch awaited in the confirm-PDF request (45 s fetch timeout), plus the existing sweep endpoint kept as a manual `curl` safety net.
- Document the four `WEBSACO3_*` env vars in `.env.example` and in the docs/runbook.

### Out of Scope
- The WebSaco3 receiver (counterpart change in WEBSACO3).
- Checking the id against WebSaco3 at save time (that would be an inbound dependency).
- An admin UI or button to retry `fallido` rows.
- Cloud Scheduler, Cloud Tasks or any other new GCP service.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `building-management-activation`: activation requires `websaco3CopropiedadId`, not NIT+DV.
- `invoice-batch-publication`: the payload identity field changes, the skip rule changes, legacy rows get defined handling, sending is dispatched immediately on confirmation, and the sweep becomes a documented manual safety net.

## Approach

- **Contract.** `POST /api/v1/webhooks/finanzas/lotes`.
  - The HMAC (`${ts}.${rawBody}`) and its headers do not change.
  - Body: `{ websaco3CopropiedadId, loteId, facturas[{numeroFactura}], urlSigned, urlExpiresAt }`.
- **Outbox identity (decision for design).** Today `encolar` snapshots `nit` into a required `PublicacionLote.nit`, and the send path reads it from the row.
  - **Recommended:** resolve the id from `Copropiedad` at send time and drop the required `nit`. Then correcting a mistyped id also fixes rows that are already queued.
  - If the id is missing at send time, the row becomes terminal `fallido` with `sin-websaco3-id`.
  - The alternative is to snapshot the id at enqueue time. That fits the existing snapshot pattern, but a typo is then frozen into the row.
- **Trigger (decided).** Immediate dispatch, awaited inside the confirm-PDF request.
  - After `encolar` writes the row, the listener calls `publicarAhora(loteId)`. It claims that lote's row, sends it, and releases it before the response is returned. It has to be awaited because Cloud Run throttles CPU once the response is sent.
  - The outbound fetch timeout is 45 s, to cover a WebSaco3 cold start (Cloud Run scales to zero). All errors are swallowed, so confirming the PDF never fails because of publication.
  - **No Cloud Scheduler and no new GCP service** (rejected by the user). The existing sweep endpoint stays only as a manual safety net run by an operator with a documented `curl` (`X-Scheduler-Secret`). No UI button.
  - Retryable rows (timeouts, 5xx, 429) are NOT retried automatically. The operator runs the `curl`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/database/schemas/copropiedades/copropiedad.schema.ts` | Modified | new field |
| `src/modules/copropiedades/` (DTO, mapper, service) | Modified | validation, NIT rule removed |
| `src/contracts/index.ts` | Modified | coproperty shape |
| `src/modules/publicacion-facturas/` (service, mapper, contrato, specs) | Modified | payload, skip rule, legacy rows |
| `src/database/schemas/publicaciones/publicacion-lote.schema.ts` | Modified | `nit` stops being required |
| `frontend/src/pages/copropiedad-form.tsx`, `frontend/src/lib/api/copropiedades.ts` | Modified | input + validation |
| `publicacion-facturas.service.ts`, `.listener.ts`, `.politica.ts` | Modified | `publicarAhora` awaited from the listener, 45 s fetch timeout |
| `.env.example`, `README.md`, `docs/runbooks/publicacion-websaco3.md` | Modified / Created | env vars, manual sweep `curl` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| A mistyped or wrongly pasted `_id` publishes to the wrong coproperty | Med | **Accepted by the user.** Format check, helper text, and live resolution so a correction takes effect |
| WebSaco3 contract drift | Med | Contract is fixed above and shared with the counterpart |
| No automatic retry for retryable rows (`pendiente`, retryable `fallido`, stale `enviando`) | Med | **Accepted operational debt.** The operator runs the documented `curl`; the runbook includes a Mongo query to find those rows |
| Confirm-PDF latency of up to ~55 s on a cold WebSaco3 (45 s timeout, awaited in-request) | Med | Frontend has no client timeout and shows a progress modal; the "Abrir" toast covers a blocked `window.open`. Validate the deployed Cloud Run request timeout (default 300 s) |
| Legacy flagged coproperty has no id when it confirms its next lote | Med | Rollout order: load ids first. Otherwise the lote is skipped with a warning and is not recovered |
| `.env.example` cannot be read by this agent (permission denied) | — | The apply phase must edit it under the user's permission |

## Rollback Plan

- Revert the commit.
- The new field is optional and stays inert on documents.
- If `nit` was dropped from the payload, restore the NIT mapper and make `PublicacionLote.nit` required again. Rows created without `nit` stay `fallido`/inert.
- Unsetting the `WEBSACO3_*` env vars stops all sends: `publicarAhora` becomes a no-op and rows stay `pendiente`.

## Dependencies

- The WebSaco3 receiver at the new route.
- A shared `WEBSACO3_HMAC_SECRET`.

## Success Criteria

- [ ] `npm run typecheck && npm run lint && npm test` pass.
- [ ] Turning the flag on without a valid 24-hex id is rejected by the DTO, the service and the form.
- [ ] The payload contains `websaco3CopropiedadId` and no `nit`.
- [ ] Legacy rows are handled as decided in design (tested).
- [ ] Confirming a lote leaves its row `enviado` against the receiver, with no `curl` and no scheduler.
- [ ] A send failure (timeout, 5xx) never makes the confirm-PDF request fail.
- [ ] The manual `curl` drains a `pendiente` row with a valid secret and is rejected without it.

## Review Workload

About 700 changed lines. **Risk: High** against the 400-line budget, so deliver as 4 PRs:

| PR | Content | Lines |
|----|---------|-------|
| 1 | `websaco3CopropiedadId` in copropiedades (schema, DTO, service, mapper, contracts, tests) | ~200 |
| 2 | Publication: id resolution, `publicarAhora`, 45 s timeout, tests (depends on PR 1) | ~250 |
| 3 | Docs: runbook with the manual `curl`, `INSTALACION-REFERENCE`, `README`, `.env.example` | ~80 |
| 4 | Frontend: input, validation, tests (depends on PR 1 deployed) | ~190 |
