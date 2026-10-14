# Design: Link invoice publication to WebSaco3 by `_id`

## Technical Approach

Add `Copropiedad.websaco3CopropiedadId` and make it the only identity sent to WebSaco3. The outbox stops snapshotting identity: `procesar` reads the id from the live `Copropiedad` before it signs a URL, and NIT leaves the integration.

The dead outbox gets fixed without any new GCP service. The confirm request that writes the outbox row also sends that row right away, and it waits for the send to finish. WebSaco3 runs on Cloud Run and scales to zero, so it is never down, only cold: the platform holds the request until an instance is up. The fetch timeout is sized to cover that cold start.

The existing sweep endpoint stays. Its role becomes a manual safety net that an operator runs with a documented `curl`.

The edge/domain split is unchanged. Only `copropiedades` (catalog) and `publicacion-facturas` (edge) change, and `LotesController` keeps emitting the same event.

## Architecture Decisions

| # | Topic | Choice | Rejected | Why |
|---|---|---|---|---|
| 1 | Link key | `websaco3CopropiedadId`, 24-hex, stored lowercase and trimmed | NIT; NIT plus id | NIT is ambiguous on the WebSaco3 side (user decision). Two keys would drift apart |
| 2 | Format check | `@Matches(/^[0-9a-f]{24}$/i)` in the DTO and the same regex in the service, exported once as `WEBSACO3_COPROPIEDAD_ID_REGEX` (`src/modules/copropiedades/websaco3-copropiedad-id.ts`) | `@IsMongoId()` / `isMongoId()`; `Types.ObjectId.isValid` | Both layers use one predicate. `isValid` also accepts any 12-byte string. `isMongoId` is rejected because of the `0x`/`0h` prefix quirk: validator's `isHexadecimal` allows an optional `0x`/`0h` prefix, so `'0x' + 22 hex chars` passes as a "Mongo id". The FRONTEND helper (`src/lib/websaco3.ts`, PR 4) MUST use the same strict regex |
| 3 | Where the id is resolved | At send time, from the current `Copropiedad` | A snapshot at enqueue | A corrected id also fixes rows that are already queued |
| 4 | `PublicacionLote.nit` | Remove the `@Prop`. Legacy docs keep an inert `nit` | Make it optional; a `$unset` migration | Nothing reads it, and no index includes it. Strict mode ignores the extra key |
| 5 | Id missing at send | Terminal `fallido`, `ultimoError:'sin-websaco3-id'`. No URL is signed and no fetch is made | Retry | No retry can fix missing data. This also covers a coproperty that is not found or has the flag off |
| 6 | The coproperty read throws | `desenlaceReintentar(..., 'copropiedad-lectura')` | Let it throw | A throw would leave the row stuck in `enviando` until `CLAIM_TTL_MS` |
| 7 | Enqueue rule | Flag on with no id: log a warning, write no row | Enqueue anyway | Matches the spec |
| 8 | Flag off | The service forces `websaco3CopropiedadId: null` | Reject with 400 | Keeps the invariant `id ≠ null ⇔ flag on` |
| 9 | Trigger | **An immediate, awaited dispatch.** After `encolar` writes the row, the listener calls `publicarAhora(loteId)` inside the same `emitAsync`. That method claims **this lote's row** through the existing atomic `reclamar`, then runs `procesar` and `liberar` | Cloud Scheduler or Cloud Tasks (a new GCP service, rejected by the user); `setImmediate` fire-and-forget; draining other due rows on every confirm | Cloud Run throttles CPU once the response is sent, so the send must finish before the response goes out. Reusing the claim logic keeps one state machine. Draining other rows would add unrelated latency to a user request |
| 10 | Fetch timeout | `FETCH_TIMEOUT_MS = 45_000`, a named constant in `politica.ts`, not an env var | 15 s (current); 60 s | See "Timeout budget" below |
| 11 | Sweep endpoint | Kept as is: `POST /api/v1/interno/publicacion-facturas/procesar-pendientes`, guarded by `X-Scheduler-Secret`. It becomes an operator-run safety net for rows left `pendiente`, retryable `fallido`, or stale `enviando`. Nothing is renamed | A frontend retry button (rejected by the user); removing the endpoint | Retries and backoff still need an entry point |
| 12 | Response contract | No code change (2xx/409 sent; 422/429/5xx retry; 400/404/other 4xx terminal) | New codes | Only the docblock changes: the `[spec-gap]` note is dropped and the WebSaco3 contract is cited |

**Timeout budget.**
- A cold start of WebSaco3 (Node boot plus the Mongo connection) is typically 5–30 s. 45 s covers that with margin. 15 s would turn ordinary cold starts into retryable timeouts, and without a scheduler those are only retried by hand.
- 60 s was rejected. A receiver that hangs while warm makes the user wait the whole timeout, and anything past 45 s is an incident rather than a cold start.
- Worst case for the confirm request: its existing work (confirm, then the snapshot block, a few seconds), plus URL signing, plus 45 s, which comes to roughly 55 s. That is well under Cloud Run's default 300 s request timeout. The repo sets no override; validate the deployed value.
- The sweep still fits. `PRESUPUESTO_CICLO_MS` (120 s) is checked against `FETCH_TIMEOUT_MS + MARGEN_CICLO_MS` (50 s), so every cycle sends at least one row. `CLAIM_TTL_MS` (5 min) stays above 45 s plus signing.
- `redirect:'error'` is kept.

**Audit-law guard.** `deshacerConsolidacion` refuses the undo when a `PublicacionLote` row exists. `encolar` still writes that row **before** the send attempt, and the send only mutates the row's queue fields, so the guard sees exactly what it saw before. A skipped enqueue (no id) writes no row, but the lote's generated FV PDF already refuses the undo on its own. Interaction unchanged.

**Frontend latency.** `axios.create({ baseURL })` sets no `timeout` (axios default 0, meaning none), so **the client timeout does not need to change**. `confirmar-generacion` runs inside `resolverUrlLoteFacturas`, behind the `generarYAbrir` progress modal, and it also runs automatically when `lote-exito.tsx` mounts.
- A cold WebSaco3 adds up to about 45 s before the PDF opens.
- After that long a wait, the browser may block `window.open`. The existing "Abrir" toast fallback covers this.
- If the user leaves mid-request, the row already exists. At worst it sits in `enviando` until `CLAIM_TTL_MS` expires and the manual sweep picks it up.

## Data Flow

```
POST /lotes/:id/facturas/confirmar-generacion
  generacion.confirmar ─> await emitAsync(PDF_CONFIRMADO)
    Listener (swallows ALL errors):
      encolar(evento) ─> flag && id ? upsert row : warn/skip        (returns boolean)
      row ensured ─> publicarAhora(loteId):
        !transporteConfigurado ─> no-op (row stays pendiente)
        reclamar(max, loteId) ─> null? no-op (already sent / claimed / exhausted)
        procesar(row):
          Copropiedad.findById ─ throw ─> retry 'copropiedad-lectura'
          !flag || !id ─> terminal 'sin-websaco3-id'
          generarUrlLectura ─> construirPayload ─> firmar ─> fetch(45 s, redirect:'error')
        liberar(row, desenlace)
  snapshot block ─> 200

Operator curl ─> Guard(X-Scheduler-Secret) ─> procesarPendientes (unchanged loop)
```

## File Changes

**Backend** (`backend/`)

| File | Action | Change |
|---|---|---|
| `src/database/schemas/copropiedades/copropiedad.schema.ts` | Modify | Add `websaco3CopropiedadId` (`String`, default `null`, `trim`, `lowercase`, no index) |
| `src/modules/copropiedades/dto/guardar-copropiedad.dto.ts` | Modify | `@IsOptional() @Matches(WEBSACO3_COPROPIEDAD_ID_REGEX, { message })` |
| `src/modules/copropiedades/websaco3-copropiedad-id.ts` | Create | The shared strict regex, with a comment on why `isMongoId` is not used |
| `src/contracts/index.ts`, `copropiedades.mapper.ts` | Modify | Expose the field, with `?? null` for legacy docs |
| `src/modules/copropiedades/copropiedades.service.ts` | Modify | `aplicarReglaGestionEdificios(cambios, actual)`: flag on requires the id (else 400); flag off sets `null`; the NIT gate is removed. `update` selects both keys |
| `src/database/schemas/publicaciones/publicacion-lote.schema.ts` | Modify | Drop `nit`; update the docblock |
| `publicacion-facturas.contrato.ts`, `.mapper.ts` | Modify | `nit` becomes `websaco3CopropiedadId`; new signature `construirPayload(fila, id, url, exp)` |
| `publicacion-facturas.service.ts` | Modify | `encolar` returns `boolean` (true when the row exists, including on an 11000 race), uses the new select and skip rule, and writes no `nit`. `reclamar(max, loteId?)` adds an optional `loteId` filter. New `publicarAhora(loteId)` with no `enEjecucion` lock: the atomic claim alone prevents a double send. `procesar` gets the resolution step |
| `publicacion-facturas.listener.ts` | Modify | `if (await encolar(e)) await publicarAhora(e.loteId)`, inside the existing catch-all |
| `publicacion-facturas.politica.ts` | Modify | `FETCH_TIMEOUT_MS = 45_000` with a cold-start docblock. The `PRESUPUESTO_CICLO_MS` docblock now cites the operator `curl` instead of Cloud Scheduler. Drop the `[spec-gap]` note |
| `lotes.controller.ts` | Modify | Comment only: the awaited emit now also covers the send |
| `*.spec.ts` | Modify | See Testing |
| `CLAUDE.md` | Modify | Replace the `PublicacionLote` `nit` canonical row with a `websaco3CopropiedadId` row |
| `INSTALACION-REFERENCE.md`, `README.md` | Modify | A field row, and a link to the runbook |
| `docs/runbooks/publicacion-websaco3.md` | Create | The 4 `WEBSACO3_*` env vars; the immediate-dispatch behaviour; a Mongo query to find rows left `pendiente`/retryable/`enviando`; the manual `curl` (`-X POST`, `X-Scheduler-Secret`, `--max-time 150`); re-arming a terminal row; rollout order |
| `.env.example` | Modify | The 4 keys, commented out. **This agent was denied read access; apply must ask the user for permission** |
| `openspec/changes/publicar-facturas-websaco/` | Delete | A stale duplicate of the archived change. Delete it in its own commit |

**Frontend** (`frontend/`): no change from the previous revision.
- `src/lib/api/copropiedades.ts`: add the field.
- `src/lib/websaco3.ts` (+ test): `esIdWebsaco3`.
- `src/components/ui/field.tsx`: an `ayuda` line merged into `aria-describedby`.
- `src/pages/copropiedad-form.tsx` (+ test):
  - the input is shown only while the flag is on, with its helper text;
  - empty or invalid values are blocked client-side with the inline error and focus, and the error clears on change;
  - the value is sent trimmed, and only when the flag is on.
- No retry button. `client.ts` is untouched.

## Interfaces / Contracts

```ts
interface PayloadPublicacionLote {
  websaco3CopropiedadId: string; loteId: string;
  facturas: { numeroFactura: string }[]; urlSigned: string; urlExpiresAt: string;
}
// service
encolar(e: LoteFacturasPdfConfirmadoEvent): Promise<boolean>;
publicarAhora(loteId: string): Promise<void>;
reclamar(max: number, loteId?: string): Promise<FilaReclamada | null>;
```

Receiver contract: 400 means an invalid id (terminal), 404 an unknown id (terminal), 409 a duplicate `loteId` (success), and 422/429/5xx are retried.

## Testing Strategy

Jest unit tests with hand-rolled mocks (`tdd: false`).

| Layer | What |
|---|---|
| copropiedades service, DTO, and mapper | Unchanged from the prior revision: activation scenarios, the flag-off clear, DTO format, and the legacy `null` |
| publicacion mapper | Payload carries the id and no `nit` |
| `encolar` | Returns `false` for flag on with no id (warning logged, no write). Returns `true` on upsert and on 11000. Writes no `nit` |
| `publicarAhora` | Transport not configured: no claim. Claims with the `loteId` filter. `null` claim: no fetch. Success: `liberar` called with `enviado`. A fetch timeout produces a retryable `fallido` |
| listener | `publicarAhora` is called only when `encolar` returns `true`. A throw from either one is swallowed |
| `procesar` | Uses the corrected id. Missing id produces terminal `sin-websaco3-id` with no URL and no fetch. A `findById` throw produces a retry. 400/404 are terminal |
| politica | `FETCH_TIMEOUT_MS + 5_000 < PRESUPUESTO_CICLO_MS` and `< CLAIM_TTL_MS` (invariant test) |
| frontend | Unchanged |

## Migration / Rollout

No data migration. Order:
1. Deploy WebSaco3's receiver.
2. Deploy the backend PRs and the frontend, with the backend first because of `forbidNonWhitelisted`.
3. Set the 4 env vars. Without them, `publicarAhora` does nothing and rows stay `pendiente`.
4. **Load the ids into every legacy flagged coproperty before it confirms its next lote.** Otherwise `encolar` skips that lote with a warning, and the lote is **not** recovered.
5. Run the manual `curl` once to drain legacy `pendiente` rows. A row whose coproperty has no id goes terminal. Re-arm terminal rows per the runbook.

**PR 1 and PR 4 must ship together.** Between PR 1 and PR 4 the existing frontend form always sends `usaGestionEdificios`, so editing a legacy flagged coproperty that has no id returns 400 until PR 4 (which adds the id input) ships. Deploy PR 1 and PR 4 in the same release.

**Split recommendation** (~700 lines in total):
- PR 1, copropiedades id (~200): schema, DTO, service, mapper, contracts, tests.
- PR 2, publicacion (~250): id resolution, `publicarAhora`, the timeout, tests, and the `CLAUDE.md` row. Depends on PR 1.
- PR 3, docs (~80): the runbook with the manual `curl`, `INSTALACION-REFERENCE`, `README`, `.env.example`. The stale-directory deletion goes in its own commit.
- PR 4, frontend (~190): depends on PR 1 being deployed.

## Open Questions

- [ ] Should two coproperties be blocked from sharing one `websaco3CopropiedadId`?
- [ ] Should `copropiedad-detalle.tsx` show the id?
- [ ] What is the request timeout of the deployed Finanzas Cloud Run service? The design assumes the default 300 s.
