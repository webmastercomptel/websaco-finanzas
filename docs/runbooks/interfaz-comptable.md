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
- `rawBody`: the exact string sent as body (`''` for the GET and for
  `retirar`). The body is serialized once and never re-serialized.
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
