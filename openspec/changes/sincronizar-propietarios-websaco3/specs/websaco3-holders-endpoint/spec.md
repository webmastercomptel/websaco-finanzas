# Websaco3 Holders Endpoint Specification

New capability. Signed, read-only, per-coproperty snapshot of unit holders, pulled by WebSaco3.
Key words MUST / MUST NOT / SHOULD / MAY follow RFC 2119.

Contract anchor (shared with WEBSACO3 `recibir-propietarios-finanzas`):
`GET /api/v1/integraciones/websaco3/propietarios?websaco3CopropiedadId=<24hex>`.

Signed string (exactly, `\n` = LF, no trailing newline):

    propietarios.v1\n${ts}\n${METHOD}\n${path}\n${sortedQuery}

- `ts`: the `X-Websaco-Timestamp` header value (epoch seconds, decimal digits).
- `METHOD`: the request method as received (`GET`).
- `path`: the received request path WITHOUT query, INCLUDING the `/api/v1` prefix.
- `sortedQuery`: query pairs percent-encoded with `encodeURIComponent`, sorted by key then value (UTF-16 code-unit order), joined `k=v` with `&`; empty string when there is no query.
- Signature header: `X-Websaco-Signature: sha256=<64 lowercase hex>` = HMAC-SHA256 of the string above, key `WEBSACO3_HMAC_SECRET`.

## ADDED Requirements

### Requirement: Signed request authentication

The route MUST authenticate only through the HMAC scheme above. It MUST NOT use `FirebaseAuthGuard`, `PoliciesGuard` or CASL. The signature MUST be compared in constant time. Every authentication failure MUST return the same opaque `401` (no hint of which check failed); the reason goes to the log only, never the header values or the secret.

#### Scenario: Valid signature

- GIVEN `WEBSACO3_HMAC_SECRET` is set and a valid `X-Websaco-Timestamp`
- WHEN the caller sends `GET` with a signature computed over the signed string for that exact method, path and query
- THEN authentication passes and the request reaches validation

#### Scenario: Bad signature

- GIVEN a well-formed `X-Websaco-Signature` computed with a different secret (or one hex digit altered)
- WHEN the request is sent
- THEN the response is `401`

#### Scenario: Missing or malformed headers

- GIVEN a request without `X-Websaco-Timestamp`, or without `X-Websaco-Signature`, or with a signature not matching `^sha256=[0-9a-f]{64}$`, or with a timestamp that is not decimal digits
- WHEN the request is sent
- THEN the response is `401`

#### Scenario: Signature replayed on another query

- GIVEN a valid signature for `websaco3CopropiedadId=A`
- WHEN the same headers are sent with `websaco3CopropiedadId=B` (or with an extra parameter)
- THEN the response is `401`

#### Scenario: Signature replayed on another path or method

- GIVEN a valid signature for the holders route
- WHEN the same headers are used on the same route with a trailing slash, or with method `HEAD`
- THEN the response is `401`

#### Scenario: Signature built for another purpose or direction

- GIVEN a signature over `${ts}.${rawBody}` (the invoice-publication scheme) or over a string with a different purpose prefix
- WHEN it is sent to this route
- THEN the response is `401`

#### Scenario: Uppercase id signed as sent

- GIVEN the caller signs and sends `websaco3CopropiedadId` in uppercase
- WHEN the request is verified
- THEN the signature is checked over the id exactly as received (before lowercasing) and passes

### Requirement: Timestamp window

The timestamp MUST be within 300 seconds of the server clock in either direction (`|now - ts| <= 300`).

#### Scenario: Expired timestamp

- GIVEN a validly signed request whose `ts` is 301 s or more in the past
- WHEN it is sent
- THEN the response is `401`

#### Scenario: Future timestamp

- GIVEN a validly signed request whose `ts` is 301 s or more in the future
- WHEN it is sent
- THEN the response is `401`

#### Scenario: Edge of the window

- GIVEN a validly signed request whose `ts` is exactly 300 s from now
- WHEN it is sent
- THEN authentication passes

### Requirement: Fail closed without a secret

When `WEBSACO3_HMAC_SECRET` is unset or empty, the route MUST answer `401` to every call, including correctly shaped ones. The endpoint MUST work when only `WEBSACO3_HMAC_SECRET` is configured (the outbound URL and trigger secret are not required).

#### Scenario: Secret unset

- GIVEN `WEBSACO3_HMAC_SECRET` is not configured
- WHEN any request arrives
- THEN the response is `401` and nothing is read from the database

#### Scenario: Only the secret configured

- GIVEN `WEBSACO3_HMAC_SECRET` is set and `WEBSACO3_FACTURAS_ENDPOINT_URL` / `WEBSACO3_PUBLICACION_TRIGGER_SECRET` are absent
- WHEN the application boots and a valid signed request arrives
- THEN boot succeeds and the request is served

### Requirement: Query validation

Authentication MUST run before validation (an unsigned caller never learns whether an id is well formed or exists). The query MUST go through a DTO under the global `ValidationPipe`. `websaco3CopropiedadId` MUST match the shared strict regex `WEBSACO3_COPROPIEDAD_ID_REGEX` (24 hex, either case) and MUST be lowercased before lookup. `@IsMongoId` MUST NOT be used. Unknown query parameters MUST be rejected.

#### Scenario: Missing id

- GIVEN a validly signed request with no query
- WHEN it is processed
- THEN the response is `400`

#### Scenario: Malformed id

- GIVEN a validly signed request with `websaco3CopropiedadId` of 23 characters, non-hex, or `0x` plus 22 hex characters
- WHEN it is processed
- THEN the response is `400`

#### Scenario: Repeated or extra parameter

- GIVEN a validly signed request with `websaco3CopropiedadId` twice, or with an additional parameter
- WHEN it is processed
- THEN the response is `400`

#### Scenario: Bad signature wins over bad query

- GIVEN a request with an invalid signature AND a malformed id
- WHEN it is processed
- THEN the response is `401`, not `400`

#### Scenario: Uppercase id accepted

- GIVEN a validly signed request with the id in uppercase
- WHEN it is processed
- THEN the lookup uses the lowercase form

### Requirement: Coproperty lookup and tenant resolution

The coproperty MUST be found by `websaco3CopropiedadId` with `usaGestionEdificios: true`. The tenant for every subsequent read MUST be the found coproperty's `_id`. The tenant MUST NOT come from any header (`X-CoProperty-Id` included), body, or the caller's identity. The coproperty `estado` is not a filter.

#### Scenario: Unknown id

- GIVEN no coproperty carries the id
- WHEN a validly signed request arrives
- THEN the response is `404`

#### Scenario: Flag off

- GIVEN a coproperty exists but has `usaGestionEdificios: false`
- WHEN a validly signed request for its id arrives
- THEN the response is `404`

#### Scenario: Duplicate id

- GIVEN more than one coproperty carries the same id (legacy data)
- WHEN a validly signed request arrives
- THEN the response is `409` and no unit data is read

#### Scenario: Tenant header ignored

- GIVEN a validly signed request for coproperty A that also carries `X-CoProperty-Id` of coproperty B
- WHEN it is processed
- THEN the snapshot is the one of A and nothing of B is read

### Requirement: Snapshot content

The response MUST contain `copropiedad: { nombre }` and `unidades`, one entry per `Inmueble` of the looked-up coproperty (every `estado`), ordered by `codigo` ascending. Each entry: `codigo` (as stored), `tipo` (`Inmueble.tipoTitular`: `propietario` | `arrendatario`), `titular`.

`titular` MUST be `{ nombre, email, telefono }` when the unit's `titularId` resolves to an ACTIVE `Tercero` of the SAME coproperty; otherwise `null`. `email` is the first non-empty (trimmed) entry of `Tercero.emails`, else `null`. `telefono` is the trimmed `Tercero.telefono`, else `null`. A titular without email still appears with `email: null`.

Reads MUST be tenant-scoped (`copropiedadId` in every filter) and bounded: one query for units and one for terceros, regardless of unit count.

#### Scenario: Unit with an active titular

- GIVEN an `Inmueble` with `titularId` pointing to an active `Tercero` (`emails: ['a@x.co', 'b@x.co']`, `telefono: '3001'`) and `tipoTitular: 'arrendatario'`
- WHEN the snapshot is built
- THEN its entry is `{ codigo, tipo: 'arrendatario', titular: { nombre, email: 'a@x.co', telefono: '3001' } }`

#### Scenario: Unit without titular

- GIVEN an `Inmueble` with `titularId: null`
- WHEN the snapshot is built
- THEN its entry has `titular: null` and is still present

#### Scenario: Titular not linked or not readable

- GIVEN `titularId` points to a `Tercero` that does not exist, belongs to another coproperty, or has `estado: 'inactive'`
- WHEN the snapshot is built
- THEN the entry has `titular: null`

#### Scenario: Titular without email or phone

- GIVEN an active `Tercero` with `emails: []` and `telefono: null`
- WHEN the snapshot is built
- THEN `titular` is `{ nombre, email: null, telefono: null }`

#### Scenario: Other coproperties are not leaked

- GIVEN units and terceros exist in coproperty B
- WHEN the snapshot of A is built
- THEN no entry or titular of B appears, and every database filter carries A's `_id`

#### Scenario: No per-unit queries

- GIVEN a coproperty with 1500 units
- WHEN the snapshot is built
- THEN exactly one `Inmueble` read and at most one `Tercero` read are issued

### Requirement: Unit cap

A coproperty with more than 2000 `Inmueble` MUST be refused with `422` and `error: 'demasiadas-unidades'`; no partial snapshot is returned. Exactly 2000 MUST succeed.

#### Scenario: More than 2000 units

- GIVEN a coproperty with 2001 units
- WHEN a validly signed request arrives
- THEN the response is `422` with body `{ statusCode: 422, error: 'demasiadas-unidades', message }`

#### Scenario: Exactly 2000 units

- GIVEN a coproperty with 2000 units
- WHEN a validly signed request arrives
- THEN the response is `200` with 2000 entries

### Requirement: Response envelope and error shape

Success MUST use the project envelope `{ statusCode: 200, data: { copropiedad, unidades } }` (global `TransformInterceptor`; the route does not opt out). The consumer MUST read the payload from `data`. Errors keep Nest's `{ statusCode, message, error }` shape. Unexpected failures (database down) MUST surface as `5xx` so the caller retries; `400`, `401`, `404`, `409`, `422` are terminal for the caller.

#### Scenario: Envelope

- GIVEN a successful request
- WHEN the response is sent
- THEN the body is `{ statusCode: 200, data: { copropiedad: { nombre }, unidades: [...] } }`

#### Scenario: Database failure

- GIVEN the database read throws
- WHEN the request is processed
- THEN the response is `500`

### Requirement: Read-only edge with no domain coupling

The route MUST NOT write any data, trigger any event, or call any external system. It MUST live in its own module (`integraciones-websaco3`) registered in `app.module.ts`; removing that module and its import MUST leave every other module compiling and passing its tests. Domain modules MUST NOT import from it.

#### Scenario: Module removal

- GIVEN `IntegracionesWebsaco3Module` and its import are deleted
- WHEN `npm run typecheck` and the test suite run
- THEN no other module fails
