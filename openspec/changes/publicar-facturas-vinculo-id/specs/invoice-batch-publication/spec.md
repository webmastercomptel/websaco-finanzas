# Delta for Invoice Batch Publication

## ADDED Requirements

### Requirement: Id resolved from the current coproperty at send time

The system MUST read `websaco3CopropiedadId` from the CURRENT `Copropiedad`
on every send attempt. The outbox row MUST NOT snapshot the id, and
`PublicacionLote.nit` MUST NOT be required. A stored NIT on a legacy row
MUST be ignored. If the id is missing at send time, the row MUST become
terminal `fallido` (not retry-eligible) with reason `sin-websaco3-id`, and no
request is made.

#### Scenario: Correction reaches queued rows

- GIVEN a `pendiente` row whose coproperty id was corrected after enqueue
- WHEN the row is sent
- THEN the payload carries the corrected id

#### Scenario: Id missing at send time

- GIVEN a `pendiente` row whose coproperty has no `websaco3CopropiedadId`
- WHEN the row is sent
- THEN no HTTP request is made
- AND the row is `fallido`, not retry-eligible, with reason `sin-websaco3-id`

#### Scenario: Legacy row with NIT and no id

- GIVEN a row created before this change with a `nit` snapshot and no id
- WHEN the row is sent and the coproperty has a valid id
- THEN the payload carries the id and no `nit`

### Requirement: Immediate dispatch on confirmation

After the listener ensures the outbox row for a confirmed batch, the system
MUST attempt to send THAT row immediately, awaited inside the same
confirm-PDF request, so the send completes before the response is returned.
The outbound request MUST use a 45 s timeout to cover a cold receiver. Any
error in enqueue or send MUST be swallowed: confirming the PDF MUST NOT fail
because of publication. No scheduler service (Cloud Scheduler, Cloud Tasks) is
used. If the transport is not configured, no send is attempted.

#### Scenario: Immediate successful send

- GIVEN an enabled coproperty with a valid id and a reachable receiver
- WHEN the batch's FV PDF is confirmed
- THEN the row is `enviado` when the confirm response is returned, with no sweep call

#### Scenario: Cold receiver answers within the timeout

- GIVEN a receiver that needs up to 45 s to answer (cold start)
- WHEN the batch's FV PDF is confirmed
- THEN the system waits for the answer and the row is `enviado`

#### Scenario: Send failure does not break the confirmation

- GIVEN a send that fails (timeout, 5xx, or an exception)
- WHEN the batch's FV PDF is confirmed
- THEN the confirm request still succeeds
- AND the row reflects the outcome per the response-code table

#### Scenario: Transport not configured

- GIVEN the receiver URL or HMAC secret is not configured
- WHEN the batch's FV PDF is confirmed
- THEN the row is created and stays `pendiente`
- AND no HTTP request is made

### Requirement: Manual sweep safety net documented

`POST /api/v1/interno/publicacion-facturas/procesar-pendientes` MUST remain as
a manual, operator-run safety net for rows left `pendiente`, retry-eligible
`fallido`, or stale `enviando`. It MUST be authenticated with
`X-Scheduler-Secret` (`WEBSACO3_PUBLICACION_TRIGGER_SECRET`); calls without a
valid secret MUST be rejected. The runbook MUST document the `curl` for it,
and no Cloud Scheduler job or UI button is provisioned. `.env.example` and the
docs MUST document `WEBSACO3_FACTURAS_ENDPOINT_URL`, `WEBSACO3_HMAC_SECRET`,
`WEBSACO3_PUBLICACION_TRIGGER_SECRET` and `WEBSACO3_PUBLICACION_MAX_INTENTOS`.

#### Scenario: Sweep drains a pending row

- GIVEN a `pendiente` row for a coproperty with a valid id and a reachable receiver
- WHEN the sweep endpoint is invoked with a valid secret
- THEN the row becomes `enviado`

#### Scenario: Sweep without the secret

- GIVEN the sweep endpoint
- WHEN it is called without a valid trigger secret
- THEN it is rejected and no row is processed

## MODIFIED Requirements

### Requirement: Event trigger scoped to enabled coproperties

The system MUST emit `lote-facturas.pdf-confirmado` after
`generacion.confirmar(...)` succeeds for a batch's FV PDF, and the publishing
listener MUST create an outbox row only when the batch's coproperty has
`usaGestionEdificios: true` AND a `websaco3CopropiedadId`. If the flag is on
but the id is missing, the listener MUST skip, log a warning, and create no
row. The row created MUST be attempted immediately in the same request.
(Previously: only the flag was checked; the row snapshotted the NIT; no send was attempted at creation.)

#### Scenario: Confirmed batch for an enabled coproperty

- GIVEN a coproperty with `usaGestionEdificios: true` and a valid id
- WHEN a `LoteFacturacion`'s FV PDF generation is confirmed
- THEN `lote-facturas.pdf-confirmado` is emitted with the `loteId`
- AND the listener creates an outbox row for that `loteId` in state `pendiente`
- AND that row is attempted immediately in the same request

#### Scenario: Confirmed batch for a disabled coproperty

- GIVEN a coproperty with `usaGestionEdificios: false`
- WHEN a `LoteFacturacion`'s FV PDF generation is confirmed
- THEN the listener MUST NOT create an outbox row

#### Scenario: Flag on but id missing

- GIVEN a coproperty with `usaGestionEdificios: true` and no id
- WHEN a `LoteFacturacion`'s FV PDF generation is confirmed
- THEN the listener logs a warning and creates no outbox row

### Requirement: Signed payload contract

The system MUST build the outbound payload as
`{ websaco3CopropiedadId, loteId, facturas[{numeroFactura}], urlSigned, urlExpiresAt }`
via a pure mapper, with no `nit`. It MUST request a fresh signed read URL from
`DocumentoStorageService.generarUrlLectura` on every send attempt, and MUST
sign `${timestamp}.${rawBody}` with HMAC-SHA256 using the shared secret, sent
as `X-Websaco-Timestamp` and `X-Websaco-Signature: sha256=<hex>`.
(Previously: the identity field was `nit`.)

#### Scenario: Payload identity

- GIVEN a row whose coproperty has a valid id
- WHEN the payload is built
- THEN it contains `websaco3CopropiedadId` and does not contain `nit`

#### Scenario: Deterministic signature

- GIVEN a fixed timestamp, a fixed HMAC secret, and a fixed request body
- WHEN the system computes the HMAC-SHA256 signature over `${timestamp}.${rawBody}`
- THEN the resulting signature is identical across repeated computations

#### Scenario: Expired signed URL triggers a fresh one on retry

- GIVEN an outbox row in `fallido` eligible for retry, whose previously issued signed URL has expired
- WHEN the manual sweep or the immediate attempt processes the row
- THEN the system requests a new signed read URL before sending, rather than reusing the expired one

### Requirement: Response code determines state and retry eligibility

The system MUST transition an outbox row's state from the sender's HTTP
response, per this table, and MUST only schedule a retry for rows marked
retry-eligible:

| Response | Row state | Retry-eligible |
|---|---|---|
| Any 2xx / 409 | `enviado` | No |
| 422 / 429 / any 5xx / network error / timeout / signed-URL failure | `fallido` | Yes |
| 400 (invalid id format) / 404 (unknown id) / 401 / 403 / any other 4xx | `fallido` | No |
| Id missing at send time (`sin-websaco3-id`) | `fallido` | No |

(Previously: 400 and 404 were only covered by "any other 4xx"; `sin-websaco3-id` did not exist.)

#### Scenario: Success response

- GIVEN a pending or retry-eligible outbox row is sent
- WHEN WebSaco3 responds with any 2xx status or 409
- THEN the row transitions to `enviado` and is never retried again

#### Scenario: Transient failure response

- GIVEN a pending or retry-eligible outbox row is sent
- WHEN WebSaco3 responds with 422, 429, any 5xx status, or the call fails with a network error, timeout, or signed-URL generation failure
- THEN the row transitions to `fallido` and remains eligible for a future retry

#### Scenario: Invalid or unknown id

- GIVEN a pending or retry-eligible outbox row is sent
- WHEN WebSaco3 responds 400 (invalid id format) or 404 (unknown id)
- THEN the row transitions to `fallido` and is NOT scheduled for any further retry

#### Scenario: Terminal failure response

- GIVEN a pending or retry-eligible outbox row is sent
- WHEN WebSaco3 responds with 401, 403, or any other 4xx status not listed above
- THEN the row transitions to `fallido` and is NOT scheduled for any further retry
