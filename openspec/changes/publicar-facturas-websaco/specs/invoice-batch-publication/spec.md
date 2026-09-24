# Invoice Batch Publication Specification

## Purpose

Governs the outbound, optional edge that publishes each confirmed FV invoice
batch (`LoteFacturacion`) to WebSaco3, for coproperties with
`usesBuildingManagement: true`. The billing domain only emits a fact; this
capability owns everything downstream — the outbox row, the signed request,
response handling, and retries.

## Requirements

### Requirement: Event trigger scoped to enabled coproperties

The system MUST emit `lote-facturas.pdf-confirmado` after
`generacion.confirmar(...)` succeeds for a batch's FV PDF, and the publishing
listener MUST create an outbox row only when the batch's coproperty has
`usesBuildingManagement: true`.

#### Scenario: Confirmed batch for an enabled coproperty

- GIVEN a coproperty with `usesBuildingManagement: true`
- WHEN a `LoteFacturacion`'s FV PDF generation is confirmed
- THEN `lote-facturas.pdf-confirmado` is emitted with the `loteId`
- AND the listener creates an outbox row for that `loteId` in state `pendiente`

#### Scenario: Confirmed batch for a disabled coproperty

- GIVEN a coproperty with `usesBuildingManagement: false`
- WHEN a `LoteFacturacion`'s FV PDF generation is confirmed
- THEN the listener MUST NOT create an outbox row

### Requirement: Idempotent outbox row per batch

The system MUST keep at most one outbox row per `loteId`, upserting rather
than duplicating on repeated events.

#### Scenario: Duplicate event for the same batch

- GIVEN an outbox row already exists for a `loteId`
- WHEN `lote-facturas.pdf-confirmado` is received again for that same `loteId`
- THEN the system MUST NOT create a second row — exactly one outbox row exists for that `loteId`

### Requirement: Signed payload contract

The system MUST build the outbound payload as
`{ nit, loteId, facturas[{numeroFactura}], urlSigned, urlExpiresAt }` via a
pure mapper, MUST request a fresh signed read URL from
`DocumentoStorageService.generarUrlLectura` on every send attempt, and MUST
sign `${timestamp}.${rawBody}` with HMAC-SHA256 using the shared secret.

#### Scenario: Deterministic signature

- GIVEN a fixed timestamp, a fixed HMAC secret, and a fixed request body
- WHEN the system computes the HMAC-SHA256 signature over `${timestamp}.${rawBody}`
- THEN the resulting signature is identical across repeated computations

#### Scenario: Expired signed URL triggers a fresh one on retry

- GIVEN an outbox row in `fallido` eligible for retry, whose previously issued signed URL has expired
- WHEN the periodic retry sweep processes the row
- THEN the system requests a new signed read URL before sending, rather than reusing the expired one

### Requirement: Response code determines state and retry eligibility

The system MUST transition an outbox row's state from the sender's HTTP
response, per this table, and MUST only schedule a retry for rows marked
retry-eligible:

| Response | Row state | Retry-eligible |
|---|---|---|
| 201 / 202 / 409 | `enviado` | No |
| 422 / 502 | `fallido` | Yes |
| 401 / 403 | `fallido` | No |

#### Scenario: Success response

- GIVEN a pending or retry-eligible outbox row is sent
- WHEN WebSaco3 responds with 201, 202, or 409
- THEN the row transitions to `enviado` and is never retried again

#### Scenario: Transient failure response

- GIVEN a pending or retry-eligible outbox row is sent
- WHEN WebSaco3 responds with 422 or 502
- THEN the row transitions to `fallido` and remains eligible for a future retry

#### Scenario: Terminal failure response

- GIVEN a pending or retry-eligible outbox row is sent
- WHEN WebSaco3 responds with 401 or 403
- THEN the row transitions to `fallido` and is NOT scheduled for any further retry

### Requirement: Backoff retry schedule with terminal exhaustion

A scheduled scan MUST retry retry-eligible `fallido` rows using exponential
backoff (1m / 5m / 15m / 1h) up to a configurable maximum attempt count.
Once that maximum is reached without a success response, the row MUST stay
in `fallido` and MUST NOT be scheduled again.

#### Scenario: Max retries exhausted

- GIVEN a retry-eligible `fallido` row that has already been retried up to the configured maximum
- WHEN the periodic retry sweep runs again
- THEN the row is left in terminal `fallido` state and is not attempted again

### Requirement: Atomic row claiming under concurrent sweep execution

The retry scan MUST claim each eligible row atomically (a single
state-transitioning `findOneAndUpdate`) before sending, so that when the
periodic retry sweep runs concurrently across multiple instances, each eligible row is
sent by at most one instance per scan.

#### Scenario: Two instances race for the same row

- GIVEN a single retry-eligible `fallido` row and two Cloud Run instances running the periodic retry sweep concurrently
- WHEN both instances scan for eligible rows at the same time
- THEN only one instance successfully claims the row and sends it
- AND the other instance finds no row left to claim and sends nothing for it

### Requirement: Signed URL never logged

The system MUST NOT write the signed read URL (`urlSigned`) to logs at any
point in the send or retry flow.

#### Scenario: Send attempt is logged

- GIVEN a send attempt for an outbox row, successful or failed
- WHEN the attempt is logged
- THEN the log entry does not contain the `urlSigned` value
