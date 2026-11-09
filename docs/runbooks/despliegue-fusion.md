# Runbook: deploying and cutting over the unified backend (Finanzas + Administración)

Scope: what is in this repo (Dockerfile, `cloudbuild.yaml`, env validation, scripts)
plus the manual steps an operator runs per environment. **Nothing here describes
the real Cloud Run service as it is today**: its configuration is not in the repo.
Every number below marked `DECISION` is a proposal to confirm; `UNMEASURED` means
nobody has measured it with the app running. Placeholders use `<ANGLE_BRACKETS>`.

Conventions used in the commands:

```bash
PROJECT=<gcp-project>            # Etapa 0 found it as `websaco-finanzas` (confirm)
REGION=<region>                  # Etapa 0 found `us-central1` (confirm)
SERVICE=<cloud-run-service>      # `websaco-finanzas` per cloudbuild.yaml substitutions
BUCKET=<FIREBASE_STORAGE_BUCKET value>
```

## 1. Order of operations

1. **Pre-flight** (section 10), including a rollback target noted down.
2. **Mongo indexes** that boot cannot create safely (section 7).
3. **Bucket** settings: CORS, UBLA, public access prevention (section 5).
4. **Env vars and secrets** on the service (section 3), before the new revision starts:
   readiness fails loudly on a half-set Comptable or SendGrid pair.
5. **Backend first**: build and deploy the new revision with **no traffic**, smoke it
   on its tag URL, then shift traffic (section 9).
6. **Frontend after**, once the backend is serving: it needs `encabezadosSubida` in
   every upload response, `permisos`/`modulos` in `GET /auth/me`, and the
   `/portal/*` and `/envio-facturas` routes. A previous frontend build should keep working
   against the new backend for what already existed (not verified); the reverse (new
   frontend, old backend) does not.
7. Post-deploy checks (section 11) with the real app, then the owner items in the
   plan ("Etapa 6 — registro").

## 2. Image and build

- One `Dockerfile` (multi-stage, runs as the image's unprivileged `node` user, port
  3000) and one `cloudbuild.yaml` (pull cache, build, push, `gcloud run services
  update --image`). The deploy step changes only the image and labels; all other
  service settings are changed with the commands in section 4.
- A manual build has no `COMMIT_SHA`:
  `gcloud builds submit --config cloudbuild.yaml --substitutions=COMMIT_SHA=<tag> .`
- `.dockerignore` keeps `.env*`, credentials, `docs/` and `node_modules` out of the
  build context.
- V8 heap: the image defaults `NODE_OPTIONS=--max-old-space-size=768` (the value
  Etapa 0.2 used for the 200 MB PDF test, inside 1 GiB). Override the `NODE_OPTIONS`
  env var of the service when its memory changes (about 75% of the limit).
- Docker `HEALTHCHECK` (ignored by Cloud Run) probes `/api/v1/health` (Mongo + Redis).
  Readiness `/api/v1/health/ready` additionally validates the Comptable and SendGrid
  settings; it is wired as the Cloud Run **startup probe** (section 4), so a missing
  per-environment setting keeps the revision out of rotation instead of restarting a
  healthy container.

## 3. Environment variables

Source of truth: `src/config/env.validation.ts` (Joi) and `src/config/app.config.ts`.
Required ones stop the boot naming the variable.

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | set to `production` | Makes `CORS_ORIGINS` required, HTTPS mandatory for `FRONTEND_URL` and `COMPTABLE_API_URL`. |
| `PORT` | injected by Cloud Run | Default 3000. |
| `MONGODB_URI` | yes | `mongodb://` or `mongodb+srv://` connection string. Secret. |
| `REDIS_URL` | yes | `redis://` or `rediss://`. Secret. |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | yes | Service account JSON, base64 on one line. Secret. Must belong to the SAME Firebase project as the frontend (section 8). |
| `FIREBASE_STORAGE_BUCKET` | yes | Bucket for generated PDFs, documents, PQR attachments, zone images, block-billing PDFs. |
| `ROOT_ADMIN_EMAIL` | yes | Only the input of `npm run seed:admin`. |
| `CORS_ORIGINS` | yes in production | Comma-separated frontend origins, scheme + host, no path. |
| `FRONTEND_URL` | optional | `https://` origin used to build links in emails; without it emails go out with no link. |
| `SENDGRID_API_KEY` + `SENDGRID_FROM_EMAIL` | optional pair | Both or neither (Joi `.and`). Sender must be a verified identity. |
| `SENDGRID_FROM_NAME` | optional | Default `WebSaco`. |
| `TRUST_PROXY_HOPS` | default 1 | See section 6. |
| `COMPTABLE_API_URL` + `COMPTABLE_HMAC_SECRET` | optional pair | URL must end in `/api/v1`; secret at least 32 chars. |
| `INTEGRACION_PANEL_HABILITADA` + `PANEL_HMAC_SECRET` | optional | Secret mandatory when enabled, different from the Comptable one. |
| `APP_ROLE` | default `all` | `all` = HTTP + queue workers + scheduled jobs (today's behaviour); `api` = HTTP only (does not consume lote jobs nor run `@Cron`); `worker` = same as `all` (HTTP stays up because Cloud Run needs a port). An `api` process still enqueues lote jobs: do not run only `api` processes, or `consolidar` waits for a worker that does not exist. |
| `SENTRY_DSN` | optional | `https://` DSN. Absent = nothing is reported. Only unexpected errors and 5xx are sent, without request data. |
| `NODE_OPTIONS` | image default | `--max-old-space-size=<MB>`. |

Read from the platform, not set by hand: `K_REVISION` (used as the Sentry release).

**Remove** from the service if still set (nothing reads them any more):
`WEBSACO3_FACTURAS_ENDPOINT_URL`, `WEBSACO3_HMAC_SECRET`,
`WEBSACO3_PUBLICACION_TRIGGER_SECRET`, `WEBSACO3_PUBLICACION_MAX_INTENTOS`, and any
other `WEBSACO3_*`. Whether the real service still has them is not known from the repo.

**Add** (new since the fusion): `APP_ROLE` (optional), `SENTRY_DSN` (optional),
`NODE_OPTIONS` (optional, the image has a default), plus whatever of the table the
service does not yet have (`SENDGRID_*`, `FRONTEND_URL` and `CORS_ORIGINS` including
the frontend origin).

Set secrets from Secret Manager, not as plain values:

```bash
gcloud run services update $SERVICE --region $REGION \
  --update-secrets=MONGODB_URI=<secret>:latest,REDIS_URL=<secret>:latest,FIREBASE_SERVICE_ACCOUNT_BASE64=<secret>:latest,SENDGRID_API_KEY=<secret>:latest \
  --update-env-vars=NODE_ENV=production,FIREBASE_STORAGE_BUCKET=$BUCKET,FRONTEND_URL=https://<frontend-host>,CORS_ORIGINS=https://<frontend-host>,SENDGRID_FROM_EMAIL=<verified-sender>,TRUST_PROXY_HOPS=1 \
  --remove-env-vars=WEBSACO3_FACTURAS_ENDPOINT_URL,WEBSACO3_HMAC_SECRET,WEBSACO3_PUBLICACION_TRIGGER_SECRET,WEBSACO3_PUBLICACION_MAX_INTENTOS
```

Each env change creates a new revision; do them together, then follow section 9.

## 4. Cloud Run settings (decisions to confirm)

Etapa 0.1 recorded for `websaco-finanzas`: min 0, max 20, 1 vCPU, 1 GiB, concurrency
80, timeout 300 s, CPU throttling on (CPU only during requests), startup CPU boost on.
That was read once on 2026-11-06; re-read before changing anything:

```bash
gcloud run services describe $SERVICE --region $REGION --format=yaml > service-before.yaml
```

| Setting | Proposed | Status |
| --- | --- | --- |
| Memory | keep 1 GiB, **raise to 2 GiB if the 200 MB PDF test peaks above ~700 MB RSS** | UNMEASURED (Etapa 0.2 pending; the plan flags that 200 MB may not fit in 1 GiB) |
| CPU | 1 vCPU | DECISION; the PDF ingest is CPU-heavy, 2 vCPU if the 200 MB test is slower than the timeout |
| Request timeout | keep 300 s | UNMEASURED: a 200 MB block ingest runs inside one request. If it does not finish in 300 s raise up to 900 s before considering a split |
| Concurrency | keep 80 | DECISION; the ingest is capped per process (429 when another is running) and per coproperty (Redis lock), so heavy work does not scale with concurrency |
| Min instances | 0 | DECISION (budget reference ~30,000 COP/month). Consequence: no instance, no `@Cron`; the start-up catch-up pass covers it. Revisit only if the cleanups turn out late |
| Max instances | 20 | DECISION. Each instance opens Redis connections (section 12): check the plan limit before letting 20 spin up |
| CPU throttling | on (default) | DECISION. Background work only happens inside requests (lote jobs are awaited by the request) |

```bash
gcloud run services update $SERVICE --region $REGION \
  --memory=<1Gi|2Gi> --cpu=<1|2> --timeout=<300> --concurrency=<80> \
  --min-instances=<0> --max-instances=<20>
# keep NODE_OPTIONS in step with the memory: 2Gi -> ~1536
gcloud run services update $SERVICE --region $REGION --update-env-vars=NODE_OPTIONS=--max-old-space-size=<1536>
```

Probes (the flag syntax changes between gcloud releases: check
`gcloud run services update --help` first; the alternative is a service YAML applied
with `gcloud run services replace`):

```bash
gcloud run services update $SERVICE --region $REGION \
  --startup-probe=httpGet.path=/api/v1/health/ready,httpGet.port=3000,initialDelaySeconds=0,periodSeconds=5,timeoutSeconds=5,failureThreshold=12 \
  --liveness-probe=httpGet.path=/api/v1/health/live,httpGet.port=3000,periodSeconds=30,timeoutSeconds=3
```

Liveness stays on `/health/live` (no dependencies): a slow Mongo must never restart
the service.

## 5. Storage bucket

All of this is per environment and cannot be detected by readiness.

**CORS** (the browser PUTs directly to signed URLs; the preflight must allow the
create-only header). `responseHeader` is the list of request headers GCS accepts.
`storage-cors.json` in the repo is the local-development version; for production
use the real frontend origins:

```json
[
  {
    "origin": ["https://<frontend-host>"],
    "method": ["GET", "PUT"],
    "responseHeader": ["Content-Type", "x-goog-if-generation-match"],
    "maxAgeSeconds": 3600
  }
]
```

```bash
gcloud storage buckets update gs://$BUCKET --cors-file=<file.json>
gcloud storage buckets describe gs://$BUCKET --format="default(cors_config)"
```

Without `x-goog-if-generation-match` there, every upload that returns
`encabezadosSubida` (documents, PQR attachments, zone images, block billing) fails in
the browser at the preflight.

**Uniform bucket-level access and public access prevention.** Order matters: first
remove public ACLs, then switch ACLs off.

```bash
# 1. Are there public objects? (legacy zone images came from the old system)
gcloud storage ls -L "gs://$BUCKET/zonas/**" | grep -i -B3 "allUsers" | head
# 2. Make them private (signed URLs are how everything is read now)
gcloud storage objects update "gs://$BUCKET/zonas/**" --predefined-acl=private
# 3. Switch ACLs off and forbid public access
gcloud storage buckets update gs://$BUCKET --uniform-bucket-level-access
gcloud storage buckets update gs://$BUCKET --public-access-prevention
gcloud storage buckets describe gs://$BUCKET --format="default(uniform_bucket_level_access,public_access_prevention)"
```

If the frontend still renders old zone image URLs that were public, they stop
working at step 2: the backend now signs zone image reads per request, so those
rows must be read through the API. Verify with one zone before doing the whole prefix.
The backend service account needs object admin on the bucket (it writes, reads and
deletes under `facturacion-bloque/`, `documentos-administracion/`, `pqrs/`, `zonas/`,
`documentos-generados/`) and the right to sign URLs.

## 6. `TRUST_PROXY_HOPS`

It decides what `req.ip` is, which keys the per-address limit of the public access-link
redeem (`POST /auth/enlace/canjear`).

- `1` (default): Cloud Run directly behind Google's front end.
- `2`: an external HTTPS load balancer in front of Cloud Run.
- `0`: the process is exposed directly (X-Forwarded-For ignored).
- Too low is safe (everyone looks like the proxy and shares one limit); too high lets
  a client choose its own address. Never use a value larger than the number of proxies
  you can name.

What `req.ip` really is on this service has never been verified (the plan lists it
as unverified). To check: from two different networks, send repeated invalid redeem
requests to `/api/v1/auth/enlace/canjear` and see whether the 429 is per network (value
right) or shared by both (too low) — never test this against production data.

## 7. Mongo indexes

Mongoose creates indexes at boot (`autoIndex` on), but **a unique index over data that
already has duplicates fails silently**: the app boots green and the index is missing.

- Collections new to this database (`adm_*`, `envios_factura`) are empty: their unique
  indexes (`adm_pqr.codigo`, `adm_reservas` partial, `adm_roles` collation index,
  `adm_zonas`, `adm_documentos_carpetas.slug`, `envios_factura` `unico_envio_por_factura`,
  ...) are built on first boot without risk. If you load data into them from the old
  system, load it AFTER the first boot, or expect duplicate-key failures during the load.
- Run, before deploying and against the real database, the existing guard scripts, each
  of which lists duplicates first and refuses to build the index while any exist (read
  the header of each file for its flags; they take their own `MONGODB_URI` via
  `node --env-file=<file outside the repo> scripts/<name>.js`):
  `scripts/migrate-copropiedad-websaco3-id-index.js`,
  `scripts/migrate-copropiedad-comptable-id-index.js`,
  `scripts/migrate-asiento-contable-facturaid-index.js`.
- Check afterwards in `mongosh`:
  `db.getCollection('envios_factura').getIndexes()` and the same for each `adm_*`
  collection; an expected unique index that is absent means duplicates blocked it.

## 8. Firebase

- Frontend and backend must use the **same Firebase project**: the backend verifies
  ID tokens with its service account, and the access-link redeem returns a custom token
  minted by that same account, which the SPA exchanges with `signInWithCustomToken`.
  A frontend pointed at another project gets an opaque 401 on every call.
- Check the backend side without printing the key:
  `node -e "console.log(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,'base64')).project_id)"`
  and compare it with the frontend's Firebase project id.
- The pool is shared with real users of the old Administración system (see the root
  `CLAUDE.md`): the backend never writes users except through `FirebaseUsuariosService`.
  Decide the identity migration in its own plan, not here.

## 9. Deploy without traffic, verify, shift

Pin traffic to the current revision FIRST, so building a new one cannot take traffic by
itself (a service whose traffic follows "latest" routes 100% to a new revision):

```bash
gcloud run services describe $SERVICE --region $REGION --format="value(status.traffic[].revisionName)"   # note it: PREVIOUS
gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=<PREVIOUS>=100
# deploy: Cloud Build trigger, or `gcloud builds submit --config cloudbuild.yaml --substitutions=COMMIT_SHA=<tag> .`
gcloud run revisions list --service $SERVICE --region $REGION     # note it: NEW
gcloud run services update-traffic $SERVICE --region $REGION --set-tags=candidate=<NEW>
# smoke test against the tag URL (section 11), then:
gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=<NEW>=10,<PREVIOUS>=90
gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=<NEW>=100
```

If the new revision never becomes ready, its startup probe (`/health/ready`) is
telling you which indicator fails (`mongodb`, `redis`, `integracion-comptable`,
`correo`) by setting name; it never prints values.

## 10. Pre-flight checklist

- [ ] Rollback target noted (`PREVIOUS` revision name) and `service-before.yaml` saved.
- [ ] Mongo backup/snapshot taken (Atlas) and its restore time known.
- [ ] Index scripts of section 7 run, output clean.
- [ ] Bucket CORS updated with the production frontend origin and the create-only header.
- [ ] Public ACLs removed from `zonas/`; UBLA and public access prevention applied.
- [ ] Env vars of section 3 set; `WEBSACO3_*` removed; secrets come from Secret Manager.
- [ ] `FIREBASE_SERVICE_ACCOUNT_BASE64` project id equals the frontend's Firebase project.
- [ ] SendGrid: sender verified, domain authenticated, click and open tracking off (below).
- [ ] Redis capacity checked (section 12).
- [ ] `CORS_ORIGINS` and `FRONTEND_URL` contain the frontend's real origin.
- [ ] Memory/timeout decisions of section 4 confirmed or consciously deferred.
- [ ] A test coproperty exists for the post-deploy checks (never a client's).

**SendGrid account settings.** Domain authentication (SPF/DKIM) for the sender's
domain; Settings > Tracking: Click Tracking OFF and Open Tracking OFF (the backend
already disables both per message, because emails carry sign-in links that are
credentials and click tracking would rewrite and log them at SendGrid; the account
setting is the second lock); the API key with only "Mail Send" permission.

## 11. Smoke test and post-deploy checks

`scripts/smoke-fusion.mjs` (plain Node 22, no dependencies, GET/OPTIONS only, never
prints the token). It checks liveness, readiness, `/health`, that protected routes answer
401 without a token and with a bad one, a 404, an optional CORS preflight, and with a
token `/auth/me` and two routes that must not answer 5xx.

```bash
# unauthenticated, against the candidate revision tag URL
node scripts/smoke-fusion.mjs --base-url https://candidate---<service>-<hash>-<region>.a.run.app --origin https://<frontend-host>

# authenticated (ID token of a real account of a test coproperty)
ID_TOKEN=<token> COPROPERTY_ID=<id> node scripts/smoke-fusion.mjs --base-url https://<service-url> --origin https://<frontend-host>
```

It exits 1 when any check fails. It does not replace the owner's checks with the app
running (large PDF, real email, two tabs, `/portal/*` as owner and tenant), listed in
the plan.

## 12. Redis capacity

Each process opens one shared client plus BullMQ connections: per queue a `Queue`, a
`QueueEvents` and (only with `APP_ROLE` `all`/`worker`) a `Worker`; two queues today
(`consolidacion-lotes`, `aplicacion-lote-recibos`). Roughly 8 to 12 connections per
instance (estimate, UNMEASURED), times max-instances 20.

```bash
redis-cli -u "$REDIS_URL" INFO clients          # connected_clients now
redis-cli -u "$REDIS_URL" INFO memory           # used_memory_human, maxmemory_human
redis-cli -u "$REDIS_URL" INFO stats | grep -E "rejected_connections|evicted_keys"
redis-cli -u "$REDIS_URL" CLIENT LIST | wc -l   # count after starting ONE instance, to replace the estimate
redis-cli -u "$REDIS_URL" DBSIZE
```

Compare with the plan's limits in the Redis Cloud console (Etapa 0.5 is still open):
`connected_clients` at max-instances must stay below the connection limit, and
`evicted_keys` must stay 0 (locks and job state must not be evicted). Powering the
old Administración Redis off comes last, after this check passes.

## 13. Rollback

```bash
# stop sending traffic to the new revision, keep it for inspection
gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=<PREVIOUS>=100
# gradual variant while investigating
gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=<NEW>=5,<PREVIOUS>=95
```

Rolling back the code does not roll back data. Forward-only (the old revision ignores
them, but nothing removes them):

- `envios_factura` (invoice send ledger: rows are the audit of who was notified; never
  delete them to "redo" a send).
- Every `adm_*` collection (Administración data created after the cutover).
- Indexes created by the new revision, Storage objects written under the new prefixes,
  and `Copropiedad.modulosContratados` / `Asignacion` fields written by the new code.

Env var changes are revisions too: reverting only the code revision keeps the newer
env vars if the previous revision is in the same service config; check
`gcloud run revisions describe <PREVIOUS>` for the env it actually had. The frontend
rollback depends on where it is hosted (not in this repo): redeploy its previous build;
a frontend older than the backend keeps working, one newer than the backend does not.

## Pasos por ambiente (this change)

| Step | Detected by readiness? |
| --- | --- |
| Bucket CORS with `x-goog-if-generation-match` | No: it is a property of the bucket |
| UBLA, public access prevention, private `zonas/` | No |
| `SENTRY_DSN`, `APP_ROLE`, `NODE_OPTIONS` | No: all optional, default behaviour unchanged |
| Index scripts of section 7 | No: a missing unique index is silent (check by hand) |
| Removing `WEBSACO3_*` | No (harmless if left) |
