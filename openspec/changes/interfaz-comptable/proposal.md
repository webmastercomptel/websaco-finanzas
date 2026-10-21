# Proposal: "Interfaz a Comptable" — manual, signed push of asientos to Comptable

> `artifact_store.mode`: openspec · phase: sdd-propose · counterpart: Comptable
> `backend/docs/superpowers/specs/2026-10-21-comptable-integracion-websaco-finanzas-design.md`
> (the receiving side and the **canonical wire contract v1** — this proposal
> does not restate it, to keep exactly one copy).

## Intent

Today the accountant exports MOVMES.csv/MOVMESDO.csv from `adicion-contabilidad`
and loads them by hand into the accounting system. When the coproperty's books
live in Comptable, Finanzas sends the same asientos straight to Comptable's API
instead — on demand, from a new screen, never automatically.

## Owner decisions (2026-10-21)

1. Manual only: no events, outbox, queue, scheduler or automatic retry.
2. `Copropiedad.comptableEmpresaId` — one-to-one, entered on the Copropiedades
   form, validated against Comptable (signed `GET`) before it is saved. Having
   it is the whole authorization: no extra allow-list or flag.
3. Same selection as MOVMES (FV, RC, NC, ND, NT, NA of the last consolidated
   billing period + entries released by desmarcar), but an **independent
   channel**: its own lote, its own stamp on `AsientoContable`. Exporting CSV
   and sending to Comptable never affect each other.
4. The payload follows **Comptable's schema**, not the CSV layout: no
   fixed-width keys, no literal `"3"`, no comprobante column.
5. Tercero = `Movimiento.tercero` (the inmueble's code) as identificación;
   the name/tipo de persona/contact data come from the inmueble's titular
   (`Inmueble.titularId` → `Tercero`) so Comptable can create it when
   missing. An inmueble without titular blocks the send, and the preview
   lists it before anything leaves. Centro de costo → `centroUtilidad`;
   `centroDestino` always null. `baseGravable` is sent as Finanzas has it.
6. Tipo de documento, prefijo and número sent **separately** and unchanged,
   taken from the anchor document's own `prefijo`/`numero` (already resolved
   by `buildAnchorMap`), never from the glued CSV key.
7. All or nothing: Comptable rejects the whole lote on any error; Finanzas
   stamps nothing unless Comptable answered 201.
8. Desmarcar a sent lote calls Comptable's `retirar` first, which
   **hard-deletes** that lote's asientos in Comptable (owner correction,
   2026-10-21: hard delete, not soft); only on success are the local stamps
   released. The local `LoteComptable` row is kept as `retirado` (history).
9. New secret `COMPTABLE_HMAC_SECRET` (NOT `WEBSACO3_HMAC_SECRET`, which
   belongs to the WebSaco3 relationship). Signing reuses Santiago's primitives
   (`common/utils/hmac.ts`, `X-Websaco-Timestamp` / `X-Websaco-Signature:
   sha256=<hex>`, 300 s window), with a purpose-bound string
   `${ts}.${METHOD}.${path}.${rawBody}` — the rawBody computed once and sent
   unchanged.
10. New permission, its own CASL subject (not `Configuracion`).
11. Audit log entries like the CSV lotes. Only the summary is stored; for this
    first integration the screen can show the exact JSON before sending
    (debug aid).

## Scope

### In Scope
- `Copropiedad.comptableEmpresaId: string | null` + partial unique index
  (`$type: 'string'`) + migration script, same pattern as
  `websaco3CopropiedadId`; write-time uniqueness check (409) and remote
  validation (422 when Comptable says 404, 502 when it is unreachable).
- Frontend: field on `copropiedad-form.tsx`.
- Module `interfaz-comptable`:
  - `LoteComptable` schema (`lotes_comptable`): copropiedadId, number
    (own consecutive), periodStart/End, totalAsientos, totalLineas,
    totalDebitos, estado `pendiente | enviado | fallido | retirado`,
    motivoFallo, comptableLoteId, sentBy,
    retiradoPor/fecha.
  - `AsientoContable.comptableLoteId` (+ `comptableLoteRetiradoId`, mirror of
    the CSV pair) — independent from `contabilidadLoteId`.
  - Pure payload builder (asientos → contract v1), reusing the anchor/
    concepto/saldo-inicial cross resolution `AdicionContabilidadService`
    already has (extracted to a shared helper, not copied).
  - Endpoints (FirebaseAuthGuard + PoliciesGuard, tenant from context):
    `GET pendientes` (counts + the JSON preview), `POST simular`,
    `POST enviar`, `GET lotes`, `POST lotes/:id/retirar`.
  - HTTP client: one `fetch` with a 60 s `AbortController` timeout; maps
    Comptable 400 → its `errores[]` shown verbatim, 401 → "firma rechazada,
    revisa COMPTABLE_HMAC_SECRET", 409 (idempotency) → reconcile the existing
    lote, timeout/network → nothing stamped, safe to retry (same
    `loteOrigenId`).
- Env: `COMPTABLE_API_URL`, `COMPTABLE_HMAC_SECRET` (min 32), both optional
  and `.and()`-paired in Joi; screen says the integration is not configured
  when missing. `.env.example` + runbook.
- Frontend page `interfaz-comptable.tsx`: pending summary, "Ver JSON",
  "Simular", "Enviar", history with "Retirar". Blocked with a clear message
  when the copropiedad has no `comptableEmpresaId`.

### Out of Scope
Automatic sync, pulling anything back from Comptable, changing the CSV export,
FVs as electronic invoices in Comptable, storing full payloads/responses.

## Send flow (idempotent)

1. Inside a transaction: select pending entries, reserve the next
   `LoteComptable` number, create the lote as `pendiente` with its `_id` —
   that `_id` is the `loteOrigenId`.
2. Outside the transaction: signed POST to Comptable.
3. 201 → stamp entries + lote `enviado` (+ `comptableLoteId`), audit.
   400/401 → lote `fallido` with the reason, entries untouched; the next
   "Enviar" opens a new lote.
   Timeout/network → outcome unknown (Comptable may have written it): the lote
   stays `pendiente` and the screen offers only "Reintentar", which resends
   the SAME `loteOrigenId` and entries.
   409 duplicate → treat as 201 with the returned `loteId`.

## Open points (owner)

P1–P5 resolved by the owner on 2026-10-21. A sent lote can be withdrawn
**only from Finanzas**: Comptable refuses its own retiro for these lotes.
P6 resolved: the accountant may correct an integration entry in Comptable
after a warning; from then on that lote is `intervenido` and Comptable's
`retirar` answers 409 with who/when. Finanzas shows that message verbatim,
keeps its lote `enviado` with its stamps, and the history marks it
"Modificado en Comptable — ya no se puede retirar".
