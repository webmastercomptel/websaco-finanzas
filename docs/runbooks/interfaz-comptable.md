# Runbook: Interfaz a Comptable

Operator and developer guide for the manual, signed push of asientos from
Finanzas to Comptable (`src/modules/interfaz-comptable/`). Change:
`openspec/changes/interfaz-comptable/`. Receiving side and canonical wire
contract v1: Comptable's
`backend/docs/superpowers/specs/2026-10-21-comptable-integracion-websaco-finanzas-design.md`.

The integration is optional and per coproperty: a coproperty takes part only
when it has a `comptableEmpresaId`. Nothing here applies to the others, which
keep exporting MOVMES.csv/MOVMESDO.csv from "Adición a Contabilidad".

## 1. Configuration

Two variables, both optional, **set together or not at all** (Joi `.and()`:
one without the other stops the boot). With neither, the server boots and the
integration reports "no configurada".

| Variable | Value |
|---|---|
| `COMPTABLE_API_URL` | Comptable's API base **including** `/api/v1`, e.g. `https://comptable.ejemplo.com/api/v1`. `https` required in production. |
| `COMPTABLE_HMAC_SECRET` | Shared secret, at least 32 characters. **The same value** must be set as `COMPTABLE_HMAC_SECRET` in Comptable. Never reuse `WEBSACO3_HMAC_SECRET`. |

### Lines for `.env.example` (gate G.C — a human appends them)

Agents do not read or edit `.env.example` in this repo. Append exactly:

```dotenv
# Interfaz a Comptable (optional). Both or neither. The URL includes /api/v1.
# The secret is shared with Comptable (same COMPTABLE_HMAC_SECRET there),
# min 32 chars. Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
COMPTABLE_API_URL=
COMPTABLE_HMAC_SECRET=
```

### Generating and rotating the secret

Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
(64 hex characters).

Rotation has no overlap window (Comptable verifies against one secret):

1. Pick a quiet moment; nobody should be sending a lote.
2. Set the new value in Comptable and in Finanzas, then redeploy both.
3. Until both are redeployed, every call answers 401 → Finanzas shows
   "Comptable rechazó la firma… revisa COMPTABLE_HMAC_SECRET". Nothing is
   stamped on a 401, so retrying after the rollout is safe.

## 2. Signature

Every request carries `X-Websaco-Timestamp` (Unix seconds) and
`X-Websaco-Signature: sha256=<hex>`, the HMAC-SHA256 (shared primitive
`src/common/utils/hmac.ts`) of:

```
${timestamp}.${METHOD}.${ruta}.${rawBody}
```

- `ruta`: pathname + query of the exact URL fetched, including `/api/v1`
  (e.g. `/api/v1/integraciones/websaco/empresas/<id>/lotes?simular=false`).
- `rawBody`: the exact string sent as body (`''` for the GET). The lote and
  the `retirar` body (`{"solicitadoPor":{"accountId":"…","nombre":"…"}}`, the
  user who asked) are serialized once, sent with `Content-Type:
  application/json`, and never re-serialized.
- Comptable accepts a ±300 s window: the Finanzas server clock must be right.

`test/fixtures/comptable/vector-firma.json` and `payload-v1.json` are shared
byte for byte with Comptable; `comptable.firma.spec.ts` must reproduce the
vector. Never edit them on one side only.

Timeout of every call: 60 s (`COMPTABLE_TIMEOUT_MS`). The log records only the
route kind and the outcome, never a body, the secret or a signature.

## 3. Linking a coproperty to its Empresa (`comptableEmpresaId`)

Field "Id de la Empresa en Comptable" on the Copropiedades form (platform
administrators). When the value CHANGES, before anything is saved:

| Check | Answer |
|---|---|
| Not 24 hex characters | 400 |
| Already held by another coproperty | 409 "Esa Empresa de Comptable ya está asignada a otra copropiedad…" |
| Comptable answers 404 | 422 "No existe esa Empresa en Comptable." |
| Comptable unreachable / timeout / 5xx / 401 / not configured | 502, nothing saved |

`null` unlinks without calling Comptable. Resending the stored value calls
nothing. Stored trimmed and lowercase.

### Unique index — gate G.B, BEFORE deploying

Boot-time index creation fails silently on duplicates, so run:

```
node scripts/migrate-copropiedad-comptable-id-index.js --listar   # read-only
node scripts/migrate-copropiedad-comptable-id-index.js            # list + build
```

It creates `comptableEmpresaId_1` (unique, partial on `$type: 'string'`) and
refuses while duplicates or non-normalized values exist. Rollback:
`db.copropiedades.dropIndex('comptableEmpresaId_1')`.

## 4. Sending (screen "Interfaz a Comptable")

Permission keys (module `interfaz-comptable`, CASL subject `InterfazComptable`):
`interfaz-comptable.ver` (read), `.crear` (simular, enviar, reintentar),
`.anular` (retirar). `adicion-contabilidad.*` grants nothing here.

Selection = the MOVMES one on this channel's own stamp: entries of the last
consolidated billing period with `comptableLoteId: null`, plus entries a
retiro released (`comptableLoteRetiradoId`), whatever their date. The CSV
stamp (`contabilidadLoteId`) plays no part, and the CSV export ignores the
Comptable stamps.

| Route (`/api/v1/interfaz-comptable/…`) | What it does |
|---|---|
| `GET estado` | `{ configurado, comptableEmpresaId, lotePendiente }`, never throws for missing config |
| `GET pendientes` | counts, totals, `inmueblesSinTitular`, exact JSON preview |
| `POST simular` | `simular=true` in Comptable; writes nothing on either side |
| `POST enviar` | creates the lote (`pendiente`) and sends it |
| `POST lotes/:id/reintentar` | re-sends a `pendiente` lote: same id, same entries |
| `POST lotes/:id/retirar` | withdraws an `enviado` lote (Comptable first) |
| `GET lotes` | history |

### Outcomes of a send

| Comptable answer | Lote | Entries |
|---|---|---|
| 201 | `enviado` (+ `comptableLoteId`) | stamped |
| 409 `LOTE_YA_RECIBIDO` | `enviado` with the returned `loteId` | stamped |
| 400 (document errors, or DTO validation: its `message` list joined with "; ") / 401 / 404 | `fallido` + `motivoFallo` | untouched; next "Enviar" opens a new lote |
| timeout / network / 5xx / unrecognized 409 | stays `pendiente` | untouched; only "Reintentar" |

At most one `pendiente` lote per coproperty (partial unique index
`copropiedadId_pendiente_unico` on `lotes_comptable`); "Enviar" answers 409
`LOTE_PENDIENTE` while one exists. An inmueble used as tercero without a
titular blocks "Enviar" (409 `INMUEBLES_SIN_TITULAR`, with the list).

### Retiro

Comptable is called first; it hard-deletes that lote's asientos there (only if
all its months are open). Only on success are the local stamps released and
the lote marked `retirado` (kept as history). If the accountant edited the lote
in Comptable, Comptable answers 409 `LOTE_INTERVENIDO`: Finanzas shows that
sentence verbatim, stores it (`intervenidoMensaje`) and keeps the lote
`enviado` for good — it no longer calls Comptable for it.

The request body names the Finanzas user who asked (`solicitadoPor`), so
Comptable's lote reads `retiradoPorNombre: "WebSACO Finanzas — <nombre>"`.

Withdrawing is idempotent: if Comptable answers 409 `LOTE_YA_RETIRADO` (e.g. a
first "Retirar" timed out AFTER Comptable deleted the lote), Finanzas treats it
as success — releases the stamps, marks the lote `retirado` and the audit
entry says Comptable had already withdrawn it. Any other 409 (a month not open)
or a 404 changes nothing here and shows Comptable's sentence.

| Comptable answer | Lote | Entries |
|---|---|---|
| 200 / 409 `LOTE_YA_RETIRADO` | `retirado` | released (back to pendientes) |
| 409 `LOTE_INTERVENIDO` | stays `enviado` + `intervenidoMensaje`, for good | stamped |
| other 409 / 404 / 400 / 401 / timeout / 5xx | stays `enviado` | stamped |

### Audit

`registros_auditoria` with `entidadTipo: 'lote-comptable'`: `crear` (sent),
`actualizar` (rejected, no clear answer, refused because edited in Comptable),
`retirar`. Labelled `Lote N de Interfaz a Comptable de <código> <nombre> …`.

## 5. Troubleshooting

| Symptom | Cause / action |
|---|---|
| "no está configurada en este servidor" | `COMPTABLE_API_URL` / `COMPTABLE_HMAC_SECRET` missing |
| "Comptable rechazó la firma…" | secrets differ, or the server clock is off by more than 300 s |
| Lote stuck `pendiente` | "Reintentar"; Comptable deduplicates by `loteOrigenId` |
| "Algunos movimientos de este lote ya no existen" on retry | a consolidación of that period was undone after the first attempt; support must resolve the lote by hand |
