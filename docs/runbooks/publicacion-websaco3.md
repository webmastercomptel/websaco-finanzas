# Runbook: publishing invoice lotes to WebSaco3

Operator and developer guide for the outbound publication of invoice lotes to
WebSaco3 (`src/modules/publicacion-facturas/`). It covers the configuration,
the rollout order, the manual sweep (`curl`) that acts as the safety net, and
how to recover rows that did not get delivered.

Publication is optional and enabled per coproperty (`usaGestionEdificios`).
Nothing in this document applies to a coproperty that does not use the
building-management system.

## 1. How publication works

1. The user confirms the FV PDF of a lote. The domain emits
   `lote-facturas.pdf-confirmado`.
2. The listener enqueues one outbox row per lote (collection
   `publicaciones_lote`), but only if the coproperty has
   `usaGestionEdificios: true` AND a `websaco3CopropiedadId`. A flagged
   coproperty with no id is skipped with a warning in the log
   (`... tiene la gestión de edificios activa pero sin ID de WebSaco3 ...`) and
   **no row is created**, so there is nothing for the sweep to recover later.
3. The listener then sends THAT row immediately (`publicarAhora`), awaited
   inside the same confirm-PDF request. The outbound `POST` has a 45 s timeout
   (a cold receiver on Cloud Run can take 5-30 s to answer). In the worst case
   the confirm request takes about 55 s. Any error here is swallowed: confirming
   the PDF never fails because of publication.
4. If the send does not succeed, **nothing retries it automatically**. There is
   no Cloud Scheduler job, no Cloud Task and no in-process cron. An operator
   runs the manual sweep described in section 4.

The WebSaco3 id is read from the CURRENT `Copropiedad.websaco3CopropiedadId` on
every attempt and is not stored on the outbox row, so correcting a wrong id also
fixes rows that are already queued.

### Row states

| `estado` | `reintentable` | Meaning | Picked up by the sweep |
|---|---|---|---|
| `pendiente` | `true` | Enqueued, not sent yet (or transport not configured) | Yes, when `proximoIntentoEn <= now` |
| `enviando` | n/a | Claimed by an attempt in flight | Only when `reclamadoEn` is older than 5 min (`CLAIM_TTL_MS`) |
| `enviado` | `false` | Delivered (any 2xx, or 409 = receiver already has this `loteId`) | No, final |
| `fallido` | `true` | Transient failure (422, 429, 5xx, network error, timeout, signed-URL error, `copropiedad-lectura`) | Yes, when `proximoIntentoEn <= now` and `intentos < max` |
| `fallido` | `false` | Terminal (400, 404, 401, 403, any other 4xx, `sin-websaco3-id`, `reclamo-expirado`, or attempts exhausted) | No. Needs a human, see section 5 |

Backoff between automatic retry slots: 1 min, 5 min, 15 min, then 1 h
(`BACKOFF_MS`). `proximoIntentoEn` is the earliest time the sweep will claim the
row again, so a row that failed a minute ago is not claimed by a sweep run now.

## 2. Environment variables

All four live in `src/config/env.validation.ts` and `src/config/app.config.ts`.

| Variable | Required | Validation | Notes |
|---|---|---|---|
| `WEBSACO3_FACTURAS_ENDPOINT_URL` | all-or-none | `https` only when `NODE_ENV=production`; `http` or `https` otherwise | URL of WebSaco3's receiver |
| `WEBSACO3_HMAC_SECRET` | required with the URL; may also be set alone (see below) | string, minimum 32 characters | **Same value as WebSaco3's `WEBSACO3_HMAC_SECRET`.** Signs `${timestamp}.${rawBody}` (HMAC-SHA256, hex) sent as `X-Websaco-Timestamp` and `X-Websaco-Signature: sha256=<hex>`, and also authenticates the inbound holders pull (section 8) |
| `WEBSACO3_PUBLICACION_TRIGGER_SECRET` | all-or-none | string, minimum 32 characters | The value the operator sends as the `X-Scheduler-Secret` header of the manual sweep. Not shared with WebSaco3. MUST differ from the HMAC secret so either can rotate or leak on its own |
| `WEBSACO3_PUBLICACION_MAX_INTENTOS` | optional | integer from 1 to 20, default `6` | Total attempts per row, **including the first one**. It is NOT part of the all-or-none group |

### All-or-none rule (exactly what `env.validation.ts` enforces)

The Joi schema uses
`.and('WEBSACO3_FACTURAS_ENDPOINT_URL', 'WEBSACO3_PUBLICACION_TRIGGER_SECRET').with('WEBSACO3_FACTURAS_ENDPOINT_URL', 'WEBSACO3_HMAC_SECRET')`.
So the receiver URL and the trigger secret go together, and the URL also needs
the HMAC secret. The HMAC secret alone is valid (it enables only the holders
pull of section 8):

- All three absent: the app boots and publication is switched off. Rows are
  still enqueued for enabled coproperties and stay `pendiente`; `publicarAhora`
  does nothing; the sweep endpoint answers `401` to every call, because the guard
  fails closed when the trigger secret is not configured. The holders pull
  answers `401` too, because it also needs the HMAC secret.
- Only `WEBSACO3_HMAC_SECRET` present: the app boots, publication stays off, and
  the holders pull works (section 8). This is the only relaxation compared with
  the previous rule; no variable was added.
- All three present: publication is on.
- The URL without the secret, or the URL without the trigger secret (or the
  trigger secret without the URL): **the app refuses to boot** with a Joi error
  naming the missing keys. This is deliberate; a partial set would leave rows
  stuck in `pendiente` with no boot-time signal.

`WEBSACO3_PUBLICACION_MAX_INTENTOS` is validated on its own: unset means `6`, and
a value outside 1-20 or a non-integer fails boot.

An empty value (`WEBSACO3_HMAC_SECRET=`) is rejected by `Joi.string()` too. To
keep publication off, leave the three lines commented out or absent; do not set
them blank.

Changing any of these needs a restart/redeploy of the service. For the exact
lines to put in `.env.example`, see section 7.

## 3. Rollout order

1. Deploy WebSaco3's receiver (`finanzas-webhook-receptor`).
2. Deploy the backend copropiedades change and the frontend that adds the id
   input. Backend first (`forbidNonWhitelisted` rejects an unknown field). Ship
   them together: between them, editing a legacy flagged coproperty without an id
   returns 400.
3. **Load the `websaco3CopropiedadId` of EVERY legacy coproperty with
   `usaGestionEdificios: true`**, before that coproperty confirms its next lote
   on the new publication code. If a lote is confirmed while the id is missing,
   `encolar` skips it with a warning, creates no row, and that lote is NOT
   recovered.
4. Deploy the publication code and this documentation.
5. Set the three all-or-none variables (and optionally `MAX_INTENTOS`) and
   redeploy. Until then, rows just stay `pendiente`.
6. Run the manual sweep once (section 4) to drain legacy `pendiente` rows. A row
   whose coproperty still has no id goes terminal (`sin-websaco3-id`).
7. Re-arm terminal rows that you have since fixed (section 5).

## 4. Manual sweep

`POST /api/v1/interno/publicacion-facturas/procesar-pendientes`

Guarded only by the `X-Scheduler-Secret` header (compared in constant time with
`WEBSACO3_PUBLICACION_TRIGGER_SECRET`). No Firebase token, no tenant header.

### 4.1 Find the rows that need a sweep

Use `mongosh` against the Atlas database (take the connection string from your
secret store; never paste it into a ticket or into this file).

```js
// Rows a sweep can pick up: pending, retryable-failed, or a stale in-flight claim.
const staleClaim = new Date(Date.now() - 5 * 60 * 1000); // CLAIM_TTL_MS

db.publicaciones_lote
  .find(
    {
      $or: [
        { estado: 'pendiente' },
        { estado: 'fallido', reintentable: true },
        { estado: 'enviando', reclamadoEn: { $lte: staleClaim } },
      ],
    },
    {
      loteId: 1,
      copropiedadId: 1,
      estado: 1,
      reintentable: 1,
      intentos: 1,
      proximoIntentoEn: 1,
      reclamadoEn: 1,
      ultimoCodigoEstado: 1,
      ultimoError: 1,
    },
  )
  .sort({ proximoIntentoEn: 1 });
```

How to read the result:

- `proximoIntentoEn` in the future: the row is waiting out its backoff. A sweep
  run now will not claim it; wait for that time.
- `intentos >= MAX_INTENTOS` (default 6) on a retryable row: the next sweep
  closes it as terminal instead of sending it (`barrerAgotados`).
- An `enviando` row with a recent `reclamadoEn` (under 5 minutes) is an attempt in
  flight. Leave it alone.

Terminal rows, which the sweep ignores and which need a decision:

```js
db.publicaciones_lote.find(
  { estado: 'fallido', reintentable: false },
  { loteId: 1, copropiedadId: 1, intentos: 1, ultimoCodigoEstado: 1, ultimoError: 1 },
);
```

Quick overview:

```js
db.publicaciones_lote.aggregate([
  { $group: { _id: { estado: '$estado', reintentable: '$reintentable' }, filas: { $sum: 1 } } },
]);
```

### 4.2 Run the sweep with `curl`

`--max-time 150` is deliberate: one cycle is capped at 120 s
(`PRESUPUESTO_CICLO_MS`) and stops claiming new rows once fewer than 50 s remain
(45 s send timeout plus a 5 s margin), so it always finishes before 150 s and
below Cloud Run's default request timeout of 300 s. Do not lower it.

Keep the secret out of your shell history: read it into a variable instead of
typing it in the command.

**Development** (local `npm run start:dev`):

```bash
read -rs TRIGGER_SECRET   # paste WEBSACO3_PUBLICACION_TRIGGER_SECRET from your local .env
curl -sS -X POST --max-time 150 \
  -H "X-Scheduler-Secret: $TRIGGER_SECRET" \
  -w "\nHTTP %{http_code}\n" \
  http://localhost:3000/api/v1/interno/publicacion-facturas/procesar-pendientes
```

**Production** (Cloud Run; replace the host with the Finanzas API base URL):

```bash
read -rs TRIGGER_SECRET   # the production WEBSACO3_PUBLICACION_TRIGGER_SECRET
curl -sS -X POST --max-time 150 \
  -H "X-Scheduler-Secret: $TRIGGER_SECRET" \
  -w "\nHTTP %{http_code}\n" \
  https://<FINANZAS_API_HOST>/api/v1/interno/publicacion-facturas/procesar-pendientes
```

PowerShell (note `curl.exe`; plain `curl` is an alias of `Invoke-WebRequest`):

```powershell
$env:TRIGGER_SECRET = Read-Host "Trigger secret"
curl.exe -sS -X POST --max-time 150 -H "X-Scheduler-Secret: $env:TRIGGER_SECRET" -w "\nHTTP %{http_code}\n" https://<FINANZAS_API_HOST>/api/v1/interno/publicacion-facturas/procesar-pendientes
Remove-Item Env:TRIGGER_SECRET
```

### 4.3 Expected responses

| Response | Meaning | What to do |
|---|---|---|
| `200` `{"statusCode":200,"data":{"omitido":false,"reclamadas":3,"enviadas":3,"reintentar":0,"terminales":0}}` | Cycle ran. `reclamadas` rows were claimed; `enviadas` delivered, `reintentar` failed but stay retryable, `terminales` failed for good | Re-run the query in 4.1. If `reintentar > 0`, wait for the row's `proximoIntentoEn` and run again |
| `200` with all counters `0` | Nothing was eligible right now (nothing pending, or everything is waiting out its backoff) | Check `proximoIntentoEn` in 4.1 |
| `200` with `"omitido":true` | Another cycle is already running on the same instance; this call did nothing | Wait a minute and run it again |
| `401` `{"statusCode":401,"message":"Unauthorized"}` | Missing or wrong `X-Scheduler-Secret`, or the trigger secret is not configured on the service (fail closed). The reason is only in the service log | Check the secret and that the three all-or-none variables are set. No row was touched |
| `curl: (28)` timeout | The cycle outlived 150 s or the service is unreachable | Check the service logs. Rows claimed by the interrupted cycle become claimable again after 5 min |

A single cycle sends at most 25 rows. If `reclamadas` is high and rows remain,
run it again.

The response never lists rows; row-level results live in the outbox. The service
log carries short codes only (never the signed URL or a response body).

### 4.4 What to check afterwards

In Finanzas, re-run the 4.1 query: the rows should have left it. A delivered row
shows `estado: 'enviado'`, `ultimoCodigoEstado` 2xx (or 409) and `enviadoEn` set.

In WebSaco3, check that the receiver recorded each drained lote: look it up by
the `loteId` and confirm it belongs to the right coproperty (the
`websaco3CopropiedadId` Finanzas has on file) and lists the invoice numbers
(`numerosFactura`) of that lote. The receiver deduplicates by `loteId`.

## 5. Terminal rows and re-arming

The sweep never touches a terminal row. Read `ultimoError` and
`ultimoCodigoEstado`, fix the cause, and only then re-arm.

| `ultimoError` | Cause | Fix before re-arming |
|---|---|---|
| `sin-websaco3-id` | At send time the coproperty had the flag off or no id | Set the flag and a valid `websaco3CopropiedadId` on the coproperty |
| `HTTP 400` | WebSaco3 rejected the id as malformed | Correct the id on the coproperty |
| `HTTP 404` | WebSaco3 does not know that id | Correct the id on the coproperty |
| `HTTP 401` / `HTTP 403` | Credentials rejected by WebSaco3 | Make `WEBSACO3_HMAC_SECRET` identical on both sides and redeploy |
| other `HTTP 4xx` | Receiver rejected the request for good | Investigate with the WebSaco3 team |
| `reclamo-expirado` | A claim expired after attempts were exhausted. **The lote may already have been delivered**, see section 6 | Check WebSaco3 first |
| a retryable code (`HTTP 5xx`, `timeout`, `red`, ...) with `reintentable: false` | Attempts reached `MAX_INTENTOS` | Fix whatever kept failing (receiver down, etc.) |

Re-arm one row (the filter makes sure an `enviado` row can never be reset by
mistake):

```js
db.publicaciones_lote.updateOne(
  { loteId: ObjectId('<loteId>'), estado: 'fallido', reintentable: false },
  {
    $set: {
      estado: 'pendiente',
      reintentable: true,
      intentos: 0,
      proximoIntentoEn: new Date(),
      reclamadoEn: null,
      tokenReclamo: null,
      ultimoCodigoEstado: null,
      ultimoError: null,
    },
  },
);
```

`intentos` goes back to 0 on purpose: otherwise a row that exhausted its attempts
would be closed as terminal again by the next sweep. Then run the sweep (4.2).

## 6. Scenario: `liberar` fails after a successful POST

The send is a claim, a `POST`, and then `liberar`, which records the outcome. If
the `POST` reaches WebSaco3 and succeeds but `liberar` then fails (for example a
Mongo error), Finanzas never learns it worked:

- The row stays `enviando`, with its `tokenReclamo`, until `CLAIM_TTL_MS` (5 min)
  passes. The immediate-dispatch path does not catch this; the listener swallows
  the error and the confirm request still succeeds.
- Once the claim is stale, the next sweep can claim it again:
  - If `intentos < MAX_INTENTOS`, the row is sent a second time. The receiver
    deduplicates by `loteId` and answers `409`, which counts as success, so the
    row ends `enviado`. Nothing to do.
  - If `intentos >= MAX_INTENTOS`, `barrerAgotados` closes it as terminal
    `fallido` with `ultimoError: 'reclamo-expirado'` **even though WebSaco3 already
    has the lote**. The row then looks failed but the delivery actually happened.

The operator MUST check WebSaco3 before re-sending a `reclamo-expirado` row (or
any row that was `enviando` when a failure happened):

1. Look the `loteId` up in WebSaco3.
2. If WebSaco3 already has it, the delivery succeeded; do not treat it as a
   missing lote. The terminal row is only a bookkeeping artefact. Re-arming it is
   safe, since the receiver answers `409` and the row ends `enviado`, but it is
   not needed to deliver anything.
3. If WebSaco3 does not have it, re-arm the row (section 5) and run the sweep.

## 7. Lines to add to .env.example

Task 2.3 of the change `publicar-facturas-vinculo-id`. The tooling that prepared
this runbook was not allowed to read or edit `backend/.env.example`, so these
lines have NOT been added. Append them by hand. They stay commented out because
the first three must be set together or not at all (an empty value also fails
validation):

Change `holders-endpoint` (PR 2b) adds NO variable. The only edit to the existing
block is the comment above `WEBSACO3_HMAC_SECRET` (and the first comment line),
because the secret may now be set alone. Replace the block with:

```
# --- Outbound publication to WebSaco3 (optional) ---
# The receiver URL and the trigger secret go together (set both or neither), and the URL also needs WEBSACO3_HMAC_SECRET; otherwise the app will not boot.
# Receiver URL. https only when NODE_ENV=production; http or https otherwise.
# WEBSACO3_FACTURAS_ENDPOINT_URL=
# Shared with WebSaco3. Signs the outbound invoice publication AND authenticates the inbound GET /integraciones/websaco3/propietarios (purpose-bound). May be set alone to enable only the holders endpoint; URL and trigger secret remain all-or-none with each other. At least 32 characters.
# WEBSACO3_HMAC_SECRET=
# At least 32 characters. Sent by the operator as the X-Scheduler-Secret header of the manual sweep curl; distinct from WEBSACO3_HMAC_SECRET.
# WEBSACO3_PUBLICACION_TRIGGER_SECRET=
# Total attempts per row including the first (integer 1-20). Optional; defaults to 6.
# WEBSACO3_PUBLICACION_MAX_INTENTOS=6
```

## 8. Inbound holders pull (WebSaco3 reads unit holders)

The opposite direction of everything above: WebSaco3 calls Finanzas to read who
holds each unit of a coproperty. Read-only, no writes, no events. Code lives in
`src/modules/integraciones-websaco3/` and is independent of
`publicacion-facturas`: removing either leaves the other working.

`GET /api/v1/integraciones/websaco3/propietarios?websaco3CopropiedadId=<24 hex>`

### 8.1 How WebSaco3 calls it

- No Firebase token, no `X-CoProperty-Id` (ignored if sent). The coproperty is the
  one whose `websaco3CopropiedadId` equals the query value and that has
  `usaGestionEdificios` on.
- Two headers: `X-Websaco-Timestamp` (epoch seconds, decimal digits, within 300 s
  of the server clock in either direction) and
  `X-Websaco-Signature: sha256=<64 lowercase hex>`.
- Signature = HMAC-SHA256 (key `WEBSACO3_HMAC_SECRET`) of this string, `\n` = LF,
  no trailing newline:

  ```
  propietarios.v1\n${ts}\n${METHOD}\n${path}\n${sortedQuery}
  ```

  `METHOD` is the method as sent (`GET`; a `HEAD` replay fails). `path` is the
  request path WITHOUT the query, INCLUDING `/api/v1`, exactly as sent (a
  trailing slash makes it a different path). `sortedQuery` is the query pairs,
  each side percent-encoded with `encodeURIComponent`, sorted by key then value
  (UTF-16 code-unit order), joined `k=v` with `&`; empty string when there is
  no query. An uppercase id is signed exactly as sent; the server lowercases it
  only afterwards for the lookup.
- The signature is purpose-bound by the `propietarios.v1` prefix: a
  `${ts}.${body}` signature of the invoice publication never verifies here.
- The golden vector both sides must reproduce byte for byte is
  `src/modules/integraciones-websaco3/propietarios.vector.ts`
  (`VECTOR_COMPARTIDO`); WebSaco3's test holds the same values. Change both
  sides together or neither. No `curl` is needed to test: reproduce the vector.
- Success is the project envelope: read the payload from `.data`.

```
{ "statusCode": 200,
  "data": { "copropiedad": { "nombre": "..." },
            "unidades": [ { "codigo": "101", "tipo": "propietario" | "arrendatario",
                            "titular": { "nombre": "...", "email": "..." | null,
                                         "emails": ["..."],
                                         "telefono": "..." | null } | null } ] } }
```

One entry per unit (every `estado`), ordered by `codigo`. `titular` is `null`
when the unit has no holder, the party does not resolve inside that coproperty,
or the party is `inactive`.

`emails` is the party's list of VALID addresses: trimmed, deduped
case-insensitively (the first spelling is kept), in the party's original order
and capped at 50. It is `[]` when the party has no valid address. `email` is
always `emails[0]`, or `null` when `emails` is empty. This changes the meaning of
`email`: it used to be the first non-blank address, now it is the first VALID one
(an invalid first entry such as `bad` is skipped instead of being published as
the identity).

WebSaco3 uses `email` as the account identity and keeps `emails` minus that
address as the holder's alternate recipients. A snapshot WITHOUT the `emails` key
(older Finanzas) is treated by WebSaco3 as "leave alternates untouched", while
`emails: []` clears them. The key is additive, so Finanzas can be deployed before
WebSaco3 supports it.

### 8.2 Shared secret

Reuses `WEBSACO3_HMAC_SECRET`, the same value on both sides; there is no new
variable. It may be set alone (see section 2). When it is missing or blank the
route answers `401` to every call and reads nothing. Anyone with that key can
now also read holder personal data (names, emails, phones), so rotate it on both
sides together; the in-flight window is 300 s.

### 8.3 Errors

| Status | Meaning | What to check |
|---|---|---|
| `401` | Always opaque (same body whatever failed). Reason is in the server log only (`Pull de propietarios rechazado: ...`), never header values | Secret unset or different from WebSaco3's; missing or duplicated header; timestamp outside 300 s (clock skew); signature computed over a different method, path (trailing slash, missing `/api/v1`) or query; see the Cloud Run check below |
| `400` | Signature fine, query not: `websaco3CopropiedadId` missing, not exactly 24 hex (a `0x` prefix, spaces or 23 characters fail), repeated, or any extra parameter | The caller's query string |
| `404` | No coproperty has that id with `usaGestionEdificios` on | The id stored in Finanzas, and the flag |
| `409` | More than one coproperty has the id (legacy duplicates; new ones are blocked by the unique index) | Run `node scripts/migrate-copropiedad-websaco3-id-index.js --listar` and fix the duplicates |
| `422` | `demasiadas-unidades`: more than 2000 units. No partial snapshot | Terminal for the caller; needs a design change, not a retry |
| `5xx` | Database or unexpected failure | The caller retries; `400`, `401`, `404`, `409` and `422` are terminal for it |

### 8.4 Cloud Run `originalUrl` check (before the first real sync)

The guard signs `request.originalUrl` as received. If Cloud Run or any proxy in
front rewrites the path (prefix stripped, slash added or removed), every call
fails with `401` although both sides compute "the same" signature. After
deploying, make one real signed call from WebSaco3 (or a script that reproduces
the vector with the real secret) and confirm `200`. A persistent `401` with a
correct secret and a fresh timestamp means the path seen by the app differs from
the one signed.

### 8.5 Lines to add to `.env.example`

No new variable. A human must apply the comment change shown in section 7 (the
agents that prepared this change cannot read or edit `backend/.env.example`):
keep `WEBSACO3_HMAC_SECRET=` and replace the comment above it with

```
# Shared with WebSaco3. Signs the outbound invoice publication AND authenticates the inbound GET /integraciones/websaco3/propietarios (purpose-bound). May be set alone to enable only the holders endpoint; URL and trigger secret remain all-or-none with each other. At least 32 characters.
```

### 8.6 Rollout and rollback

- Do not set `FINANZAS_API_URL` in WebSaco3 until the immutable-`codigo` change
  (backend and frontend) is deployed, so a unit code cannot change between syncs.
- Run `scripts/migrate-copropiedad-websaco3-id-index.js` (`--listar` first)
  before deploying the unique-id change: boot-time index creation fails silently
  when duplicate ids exist.
- Disable at once by unsetting `WEBSACO3_HMAC_SECRET` (the route answers `401`;
  this also switches off invoice publication if it was on) or by deleting
  `IntegracionesWebsaco3Module` and its import in `src/app.module.ts`.
- Where things live: the 401 reason is the log line of `FirmaWebsaco3Guard`; the
  uniqueness of the id is enforced by `CopropiedadesService.exigirIdWebsaco3Libre`
  and the `websaco3CopropiedadId_1` partial unique index.
