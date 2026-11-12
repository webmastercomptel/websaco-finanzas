# Runbook: invoice e-mails go to every address on the records, each with a personal PDF link

Code: `src/modules/factura-publica/` (the public route, `EnlaceFacturaService`),
`src/modules/envio-facturas/` (the per-address send), `src/common/directorio/destinos-correo.ts`
(who receives), `src/modules/health/frontend-url.health.ts` (readiness) and the
frontend public page `/factura`.

## What changes

- Recipients of an invoice e-mail are the valid addresses stored on the unit's
  titular and arrendatario records (`Tercero.emails`), whether or not anybody has
  an account. The in-app notice still goes to the linked accounts.
- Each address gets its own e-mail with a button «Ver mi factura» that opens
  `<FRONTEND_URL>/factura#<token>`: one PDF, no sign-in. The token is 32 random
  bytes; only its SHA-256 is stored (`enlaces_factura`). The e-mail no longer
  carries a sign-in link.
- `POST /api/v1/publico/facturas/pdf` is the only new unauthenticated route
  (pinned in `casl/route-policies.spec.ts`). It answers the PDF bytes or ONE
  404 («El enlace no es válido o ya no está disponible») for every refusal, never
  sooner than 300 ms. Rate limit: 30 per minute per IP and 10 per minute per
  token (Redis; when Redis is down it answers 429).
- A link works for 30 days after it was minted and stops working when the invoice
  is voided, the address leaves the unit's records, the unit changes holder, the
  party or the unit is deactivated, or the coproperty is deactivated or loses the
  `finanzas` licence. Editing a record is therefore a revocation.
- `POST /envio-facturas/procesar-pendientes` answers 409 (before claiming
  anything) when `FRONTEND_URL` is missing or is not a bare origin.

## Pasos por ambiente

1. **Set `FRONTEND_URL` in every environment before deploying the per-address
   send** (https in production; scheme and domain only, no path, query,
   fragment or credentials). It is the origin the links in the e-mails are built
   from.
2. Nothing else: no migration, no seed. The only new indexes belong to the new
   collection `enlaces_factura` (`tokenHash` unique, `{copropiedadId, facturaId,
   clave}` unique, and a TTL of 90 days after `expiraEn`) and the application creates
   them.

Detected by readiness: `GET /health/ready` runs `frontend-url`. With mail
configured it fails naming `FRONTEND_URL` when it is missing or malformed (it
never prints the value); with mail not configured it reports `up` / `omitido`.
Not detectable: that the frontend has the `/factura` page deployed (see the
order below).

## Deploy order

1. Backend up to and including the public route (the link record, resolver and
   `POST /publico/facturas/pdf`). It is inert: nothing mints a link yet, and the
   invoice send behaves as before.
2. Frontend with the `/factura` page. It must be live and reachable BEFORE any
   e-mail points at it.
3. Set `FRONTEND_URL` everywhere (check `/health/ready`).
4. Backend with the per-address send and the legacy bridge (they ship together:
   do not deploy the processor without the bridge, or rows half-sent by the old
   code are e-mailed again).
5. Frontend with the new counters and copy (it reads `correosAceptados`).

## Emergency: kill every link

Links are revocable on the server. To revoke them all (or one coproperty's) in
Mongo, which needs no deploy:

```js
// every open link
db.enlaces_factura.updateMany(
  { revocadoEn: null },
  { $set: { revocadoEn: new Date() } },
);

// only one coproperty
db.enlaces_factura.updateMany(
  { revocadoEn: null, copropiedadId: ObjectId('<copropiedadId>') },
  { $set: { revocadoEn: new Date() } },
);
```

A revoked link answers the same 404 as an unknown one. Reverting the public
route (step 1 above) also kills every link already sent. The service methods
`revocarPorId` and `revocarPorFactura` do the same per link and per invoice;
they have no HTTP route yet. There is no per-address revocation: removing or
editing the address on the record already kills its links.

Never run a script against a database without reading the target first, and
prefer a single coproperty when the incident is local.

## Rollback

Reverse order: frontend counters, then the per-address send (the processor goes
back to the per-account session-link flow; the new fields stay and are ignored;
links already sent keep working while the public route is deployed), then the
`/factura` page, then the public route. **Never revert the `/factura` page while
the per-address send is live**: e-mails would point at a missing page.

## Known limits

- The link is a bearer credential for 30 days: whoever holds it (a forward, a
  shared mailbox, a compromised inbox) opens that one PDF.
- A mistyped address on a record receives the document until the record is
  fixed; fixing it kills that link, but the stranger may already have it.
- Corporate link scanners can open the page and POST the token, so `usos` and
  `primerUsoEn` are not proof that a person opened the link. The upcoming
  account-creation package must not use them as proof of ownership.
- «Aceptado» is what the provider said, not delivery: there is no bounce
  handling.
- If the process dies between the provider accepting an e-mail and the write
  of its entry, that one address may be e-mailed twice on the retry (each with
  its own token). Only the LATEST e-mail's link works: there is one link row per
  (invoice, address), and every send to that address rotates its token and
  resets its 30 days, so the link in an earlier e-mail to it stops working.
- Redis down means every public PDF answers 429 (the limiter fails closed).
- `clave` (the address hash) can be reversed with a dictionary; the collection
  keeps hashes up to 90 days after expiry.
