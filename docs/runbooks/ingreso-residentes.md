# Runbook: owners and tenants sign in by proving the address on their record

Code: `src/modules/ingreso-portal/` (the two public routes, the sign-in link store,
the request and redeem logic, the e-mail), `src/common/acceso/` (`ResidenciaService`
and `residencia.reglas.ts`: who is a resident, derived per request),
`src/common/cuentas/politica-enlace.ts` (who may ever get a session from a link),
`FirebaseUsuariosService.crearIdentidadResidente` (the only Firebase write of this
flow), `src/database/schemas/cuentas/enlace-ingreso.schema.ts` and
`revocacion-portal.schema.ts`, and the frontend public page `/ingreso`.

## What changes

- A titular or arrendatario whose e-mail is on a current holder record can ask for
  a sign-in link at `/ingreso`, with no staff step. `POST /api/v1/auth/portal/solicitar`
  answers ONE 202 («Si tu correo está registrado, te enviamos un enlace para
  entrar.») at a fixed 1,500 ms for every address, so nothing says who is on a
  record. The e-mail is sent only to an address that currently qualifies: an active
  unit, held as titular or arrendatario by an active party of the same
  coproperty, which is active and contracts a module, the address not revoked in
  every coproperty where it qualifies, and its Account (if any) active.
- The link is `<FRONTEND_URL>/ingreso#<token>`: 32 random bytes in the URL fragment,
  only their SHA-256 stored (`enlaces_ingreso`), valid 15 minutes, single use. A
  newer link for an address kills that address's earlier unused ones. Opening the
  page consumes nothing; the person presses «Entrar», which POSTs the token to
  `POST /api/v1/auth/portal/canjear`.
- The redeem consumes the link first (one atomic write), checks the address again,
  creates the Account on first use (Firebase identity `rc1_` + `claveCorreo`, with
  NO e-mail and NO password, then the Account and its audit entry in one
  transaction), records the proof on the Account (`correoProbadoClave`,
  `correoProbadoEn`, `ultimoIngresoPortalEn`) and answers a session, or
  `confirmado` for a person with Finanzas keys, an administrativo assignment or a
  platform admin account (proof only, no token: they sign in with their password).
  Every refusal is the same 401, never sooner than 300 ms.
- Both routes are `@Public` (pinned in `casl/route-policies.spec.ts`), carry
  `no-store`, `no-referrer`, `noindex` and `nosniff` on every answer including the
  400, and are limited through Redis (request: 10 per minute per IP, plus 3 per 15
  minutes and 10 per 24 hours per address; redeem: 20 per minute per IP and 5 per
  minute per token hash). When Redis is down they answer 429 by design.
- Access is derived per request from the records (see `CLAUDE.md`, «Resident access
  is DERIVED per request»). Nothing is cached, so removing the address from a
  record, a sale or a revocation takes effect on the next request.
- A generic inbox never gets a link nor address-derived access: the e-mail of a
  staff Account (platform admin or any active `Asignacion`), or an address on more
  than 3 distinct active party records across all coproperties
  (`MAX_TERCEROS_POR_CORREO`, `common/acceso/residencia.reglas.ts`). The request
  still answers the same 202; `evaluarElegibilidad` reports the reason
  `correo-generico` for the staff resend. To let such a person in, fix the records so each party carries
  the person's own address. A legacy `Tercero.accountId` link is not affected.
- Staff and resident access add up. Nothing here creates or changes an
  `Asignacion`, a role or a permission key.

## Pasos por ambiente

None. No migration, seed, backfill, script or new environment variable.

- `FRONTEND_URL` (the origin the link is built from) already has to be set for the
  per-address invoice e-mails, and `GET /health/ready` (`frontend-url`) already
  fails naming it when mail is configured and it is missing or malformed. The
  request route shares the setting and the check.
- The indexes are built by the application at boot: `enlaces_ingreso`
  (`tokenHash` unique, `{clave, usadoEn}`, TTL on `expiraEn`), `revocaciones_portal`
  (partial unique `{copropiedadId, clave}` where `activa: true`, `{clave, activa}`)
  and `emails_ci` on `terceros.emails` (collation `{locale: 'en', strength: 2}`,
  non-unique). A missing `emails_ci` makes the address lookup a collection scan,
  never a wrong answer.
- Not detectable by readiness: that the frontend has the `/ingreso` page deployed
  (see the order below), and that SendGrid delivers (readiness only reports that it
  is configured).

## Deploy order and rollback

Backend B1 (derivation, inert: nobody has a proof yet), B2 (this flow: the routes
go live), B3 (Residentes API); then the frontend (`/ingreso`, Residentes); then the
backend contract removal at least one working day later.

Rollback in reverse. Reverting B2 removes the routes; the Accounts it created stay,
inert without a new redeem. Reverting B1 as well returns the derivation to legacy
links only: a self-service resident then loses the portal.

## Operations (mongosh, on the environment's database)

The address key is `claveCorreo`: SHA-256 hex of `correo:v1:` plus the trimmed,
lowercased address.

```bash
node -e "console.log(require('crypto').createHash('sha256').update('correo:v1:'+process.argv[1].trim().toLowerCase()).digest('hex'))" 'persona@ejemplo.com'
```

Never paste an address into a shared channel or a ticket: use the `clave`.

**Revoke an address in one coproperty** (idempotent: the partial unique index and
the filter keep one active row per pair). `revocadaPor` is the `_id` of the platform
operator's own account in `accounts`:

```js
db.revocaciones_portal.updateOne(
  { copropiedadId: ObjectId('<COPROPIEDAD>'), clave: '<CLAVE>', activa: true },
  { $setOnInsert: { revocadaPor: ObjectId('<CUENTA_OPERADOR>'), revocadaEn: new Date(), levantadaPor: null, levantadaEn: null } },
  { upsert: true },
);
```

Repeat per coproperty. The address stays revoked through record edits and also
cuts a legacy link (`Tercero.accountId`), which is never cleared.

**Lift it** (the history row stays, `activa` turns false; access returns by itself
if the person had proven the address):

```js
db.revocaciones_portal.updateMany(
  { copropiedadId: ObjectId('<COPROPIEDAD>'), clave: '<CLAVE>', activa: true },
  { $set: { activa: false, levantadaPor: ObjectId('<CUENTA_OPERADOR>'), levantadaEn: new Date() } },
);
```

**Kill every live sign-in link** (for example after a leaked mailbox export):

```js
db.enlaces_ingreso.updateMany({ usadoEn: null }, { $set: { usadoEn: new Date() } });
```

**Switch one person off everywhere**: set the Account `estado` to `inactive`
(the platform Usuarios screen does the same and also disables the Firebase
identity). An inactive Account gets no link and no proof.

## Known limits (accepted)

- Whoever controls an inbox on a record controls that portal view, shared and
  property-manager mailboxes included (the trust model of the invoice e-mails). A
  typo in a record's address lets the typo's owner in until the record is fixed.
- A legacy address stored with padding does not match until its party is saved
  again (Residentes marks it as needing correction).
- A send that outlives the 1,500 ms answer runs after the reply; on request-billed
  Cloud Run it may stall and the person asks again.
- A person who signed in as a resident first and later receives Finanzas keys or an
  administrativo assignment has an identity with no e-mail: they cannot use a
  password and links stop giving them a session. Recovery is manual (a platform
  admin); there is no in-app flow for it.
- `claveCorreo` is an unsalted hash: the uid and the Redis keys can be reversed
  with a dictionary of addresses (pseudonymization only).
