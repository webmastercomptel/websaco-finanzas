# Runbook: free delegation from Equipo and Roles (Finanzas `gestionar` retired)

Code: `src/modules/casl/` (vocabulary and the cap in `delegacion.ts`),
`src/modules/equipo/`, `src/modules/roles/`, and the conversion script
`src/seed/claves-finanzas-latentes.ts` (rules in
`src/seed/claves-finanzas-latentes.nucleo.ts`).

## What changes for the data

- Finanzas `x.gestionar` stops being a key. After the deploy a stored one is an
  unknown key: it grants nothing and `GET /auth/me` does not list it. The four
  routes that needed `manage` now ask for exact keys: `DELETE /conceptos/:id`
  (`conceptos.depurar`), `DELETE /lotes/:id` (`facturas.depurar`),
  `DELETE /inmuebles/:id` (`inmuebles.depurar`) and
  `POST /lotes-recibos/:id/aplicar` (`recibos.aprobar`).
- Operational staff (`perfil: 'personal'`) and roles may now hold Finanzas keys.
  Until now any such key stored on them was inert (the read side cut it); the
  moment the veto goes, every one of them would switch ON.

The script closes both gaps **before** the new backend starts: it gives every
`x.gestionar` holder the real keys of `x` (additively, `x.gestionar` stays so
the old backend keeps working) and strips the latent Finanzas keys from
`personal` rows and roles.

## Pasos por ambiente

Per environment, in this order. `<name>` is the `--env=<name>` of the script
(`.env.<name>` in `backend/`); the `--` before the flags is mandatory, and on
Windows PowerShell try `npm.cmd run ...` (backend `CLAUDE.md`, Gotchas).

1. **Before the backend deploy, read-only:**
   `npm run revisar:claves-finanzas-latentes -- --env=<name>`.
   Exit code 1 means pending work. Keep the output in the deploy ticket. It also
   lists, without proposing any change, assignment rows that carry Administración
   keys the catalog does not offer (`usuarios.gestionar`, `pqr.crear`...): the
   system ignores them, a person decides whether they were meant to grant
   something.
2. **Announce the FREEZE:** no Usuarios edits in the platform console from step 3
   until the deploy ends (minutes). The old backend sees `*.depurar` and
   `recibos.aprobar` as unknown keys and answers 400 when such a row is saved.
3. `npm run revisar:claves-finanzas-latentes -- --env=<name> --aplicar`
   (strip on `personal` rows and roles, additive expansion on the rest,
   `x.gestionar` kept, a pre-existing dead `recibos.aprobar` removed from rows
   without `recibos.gestionar`). Re-run the default mode: it must list nothing
   and exit 0.
4. **Deploy the backend immediately.** Running the script after the deploy leaves
   every former `gestionar`-only account without that module until it runs.
5. Deploy the frontend. Order: script, backend, frontend.
6. **Manual:** a platform admin ticks «Equipo y roles» (`usuarios.*`, `roles.*`)
   on the existing Finanzas-only main accounts. No automatic grant exists;
   announce it.
7. **Later, only after the release is accepted and a rollback is no longer
   wanted:** preview with
   `npm run revisar:claves-finanzas-latentes -- --env=<name> --retirar-gestionar`
   (read-only: lists every `x.gestionar` it would remove, with the row id, email,
   scope, coproperty code and keys, and warns about rows that lack some real key
   of an `x.gestionar` they hold; exit code 1 when something would be removed),
   then `... --env=<name> --aplicar --retirar-gestionar`. Rows with a warning are
   skipped and reported, never half-edited. `--aplicar --retirar-gestionar` also
   writes the marker that makes the pre-deploy modes refuse from then on. Before this step a rollback is clean;
   after it, a rollback strands former `gestionar` holders out of the four routes
   above.
8. Rollback: frontend first, then backend.

### What the script does, by document

| Document (any scope, any `estado`) | Default / `--aplicar` |
| --- | --- |
| Assignment `perfil: 'personal'` | Strips every Finanzas-segment key, `gestionar` included. Never expanded: expanding first would activate access that was inert |
| Assignment of any other `perfil` (no `perfil` included) | Removes a dead `recibos.aprobar` (only when the row has no `recibos.gestionar`), then expands each Finanzas `x.gestionar` into the real keys of `x`, keeping `x.gestionar`. `anulaciones.gestionar` expands to nothing and loses nothing |
| Role | Strips every Finanzas-segment key |

Detection is by Finanzas segment, not by `moduloDePermiso`, because after the
deploy `x.gestionar` is no longer a known key. Every write is
`updateOne({_id, permisos: <array as read>}, ...)`: a document that changed while
the script ran is reported as a conflict and not overwritten (re-run). Idempotent:
a second pass finds nothing. It touches nothing else (not Administración or
unknown keys, not `perfil`). A row or role left with no keys stays valid.

Exit codes: read-only modes, 1 when something is pending; writing modes, 1 when
a document moved under the script; 2 when a pre-deploy mode (default or
`--aplicar`) found evidence that the backend already ran and did nothing (next
section).

### Never run the pre-deploy modes after the deploy

After the deploy a Finanzas key on a `personal` row is a legitimate grant made
from Equipo, and `recibos.aprobar` is a real key. Re-running the default mode
would list them as pending and `--aplicar` would strip them. The same goes for
the dead-`recibos.aprobar` rule once `--retirar-gestionar` has removed
`recibos.gestionar`. The script cannot see the deploy itself, so it is only
PARTIALLY guarded:

**What it detects** (read before the default mode plans anything and before
`--aplicar` writes anything; either is enough):

- the marker `--aplicar --retirar-gestionar` leaves: one document
  (`_id: 'claves-finanzas-latentes:retirar-gestionar'`) in the collection
  `marcas_despliegue`, written before that mode touches its first row, even when
  it then finds nothing to remove or hits conflicts;
- any audit entry (`audit_log_entries`) with `entidadTipo: 'rol'` or carrying
  `detalle`: only the new backend writes them (roles were not audited before,
  and `detalle` is new).

With evidence, `--aplicar` **refuses**: exit code **2**, a Spanish message naming
the evidence, nothing written. The default mode stays read-only, prints the same
evidence, says the pre-deploy modes no longer apply, lists no "pending" (those
rows are legitimate now) and also exits 2. `--retirar-gestionar` (preview and
`--aplicar`) is not guarded: it is the post-deploy step.

**What it does NOT detect:** a deployed backend where nobody has yet created or
edited a role or changed a member's keys from Equipo, and `--retirar-gestionar`
has not run. In that window there is no audit entry and no marker, so the
pre-deploy modes still run, and would strip any Finanzas key already granted
(through the Usuarios screen of the platform, which no longer vetoes them) to a
`personal` row. Likewise, a database restored or an environment where audit
entries were purged looks pre-deploy. The deploy order in "Pasos por ambiente"
stays the real protection; the guard only catches a late re-run. Running
`--aplicar --retirar-gestionar` by mistake BEFORE the deploy would also write the
marker and block the pre-deploy step: delete that one document by hand if that
ever happens.

### Readiness cannot check this

`GET /health/ready` cannot detect a missed run (backend rule 10): after the
deploy a Finanzas key on a `personal` row is legitimate, so no indicator can tell
a missed strip from a real grant. The only protection is this runbook and the
deploy ticket with the step-1 output (plus the partial guard above, which stops a
late `--aplicar`, not a missed one).

## Checking it by hand

- Default mode after step 3 prints `Pendientes: 0` and exits 0.
- `GET /auth/me` of a converted account lists the real keys (for example
  `facturas.depurar`) and never `facturas.gestionar`.
- A former `gestionar`-only account still reaches the four routes above.

## Audit trail

From this release `GET /auditoria` entries for Equipo and Roles carry `detalle`
(`agregadas`, `quitadas`: the keys the delegation cap judged). Roles are audited
(`entidadTipo: 'rol'`, and `accion: 'eliminar'` for a deletion). Older entries
have no `detalle` and need no migration.
