# Proposal: Publish invoice batches to WebSaco3

## Intent

Coproperties with `usesBuildingManagement: true` must see their issued invoices in WebSaco3. Right now the flag is only scaffolded, with no publisher behind it. Finanzas generates invoices per `LoteFacturacion` as one combined PDF in GCS. This change adds an optional outbound edge that publishes each confirmed batch, and the billing domain stays unaware of it.

## Scope

### In Scope
- Domain validation: turning the flag on requires `taxId` + `taxIdVerificationDigit`. Otherwise it fails with `BadRequestException`.
- A domain event `lote-facturas.pdf-confirmado`, emitted after the FV PDF is confirmed.
- A new `publicacion-facturas` module with an outbox schema, a listener, an HMAC-signed `fetch` sender, and periodic retry sweeps with backoff (triggered by an external Cloud Scheduler job hitting a protected internal endpoint — see design.md for why an in-process cron was rejected).
- Optional env vars `WEBSACO3_FACTURAS_ENDPOINT_URL` and `WEBSACO3_HMAC_SECRET`.

### Out of Scope
- **The WebSaco3 receiver endpoint.** It is an external contract dependency, built in another repo and session. It is NOT delivered here.
- Making `taxId` required or unique on the WebSaco3 side.
- Page-to-unit mapping. WebSaco3's own splitter handles it.
- A manual retry UI or admin endpoint for `fallido` rows.
- Publishing document types other than FV.

## Capabilities

### New Capabilities
- `invoice-batch-publication`: outbox lifecycle, the event trigger, the signed payload contract, how each response code is handled, and the retry/backoff policy.

### Modified Capabilities
- None. There are no existing specs. The new flag-activation validation is covered by a new capability:
- `building-management-activation` (new): activating the flag requires a complete NIT.

## Approach

- `LotesController.confirmarGeneracionFacturas` emits the event through `EventEmitter2` after `generacion.confirmar(...)` succeeds. `facturacion` never imports the publisher. Deleting the module leaves everything compiling.
- `@OnEvent` checks the flag and upserts an idempotent outbox row in `pendiente`, keyed by a unique `loteId`. It uses the same `findOneAndUpdate(upsert)` pattern as `numeracion.service.ts`.
- Every attempt asks `DocumentoStorageService.generarUrlLectura` for a fresh signed read URL, signs `${timestamp}.${rawBody}` with HMAC-SHA256, and POSTs with native `fetch`.
- How responses are handled:

  | Response | Row state | Retries? |
  |---|---|---|
  | 2xx/409 | `enviado` | — |
  | 422/429/5xx | `fallido` (retryable) | Yes (a new URL fixes an expired one) |
  | 401/403/other 4xx | `fallido` (terminal) | No |
  | Network error, timeout, or signed-URL failure | `fallido` (retryable) | Yes |

- An external Cloud Scheduler job periodically calls a protected internal endpoint (`SecretoProgramadorGuard`) that sweeps eligible rows and retries them with exponential backoff (1m/5m/15m/1h) up to a configurable max — no in-process `@Cron`/`@nestjs/schedule` (rejected: Cloud Run throttles CPU between requests, so an in-process timer can silently stop firing).
- The payload is `{ nit, loteId, facturas[{numeroFactura}], urlSigned, urlExpiresAt }`, built in a pure mapper.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/modules/copropiedades/copropiedades.service.ts` | Modified | NIT validation on create and update |
| `src/modules/facturacion/lotes.controller.ts` | Modified | Emit event (~L364) |
| `src/modules/publicacion-facturas/` | New | module, service, mapper, specs |
| `src/database/schemas/publicaciones/publicacion-lote.schema.ts` | New | outbox |
| `src/app.module.ts`, `src/config/env.validation.ts` | Modified | register modules and env vars |
| `package.json` | Modified | `@nestjs/event-emitter` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| A NIT collision in WebSaco3 routes to the wrong coproperty | Med | WebSaco3 makes `taxId` required (tracked separately). The user accepted the risk. |
| The receiver contract drifts before WebSaco3 builds it | Med | The contract is fixed in the spec and handed over |
| The retry sweep runs twice (overlapping Cloud Scheduler calls, or multiple Cloud Run instances) | Med | Claim rows atomically (`findOneAndUpdate` on state) |
| The signed URL leaks into logs | Low | Never log `urlSigned` |

## Rollback Plan

Remove `PublicacionFacturasModule` from `app.module.ts`. The emit becomes a no-op. Revert the NIT validation separately if needed. The outbox collection is inert and can be dropped.

## Dependencies

- The WebSaco3 receiver `POST /api/v1/facturas-externas/recepcion` (external, not part of this change).
- A shared HMAC secret, provisioned on both sides.

## Success Criteria

- [ ] `npm run typecheck && npm run lint && npm test` pass.
- [ ] Emitting the event twice produces one outbox row.
- [ ] Each response code leads to the state and retry behaviour in the table above (tested with mocked `fetch`).
- [ ] The HMAC signature is deterministic for a fixed timestamp, secret and body.
- [ ] Turning the flag on without a NIT is rejected.
