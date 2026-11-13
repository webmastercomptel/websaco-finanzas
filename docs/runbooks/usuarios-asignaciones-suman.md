# Runbook: platform Usuarios manages a list of assignments that add up

Code: `src/modules/usuarios/` (`asignaciones-usuario.service.ts`,
`asignaciones-usuario.reglas.ts`, `usuarios.controller.ts`,
`dto/guardar-asignacion-usuario.dto.ts`) and the frontend
`src/components/usuarios/` (`tabla-accesos.tsx`, `drawer-asignacion.tsx`).

## What changes

- `GET /usuarios` and `GET /usuarios/:id` carry `asignaciones[]`: every row of
  the account, active and inactive, of every `perfil`, each with its own `id`,
  `estado`, `permisos` and `cantidadRoles`. There is no "primary" row.
- Two new routes, platform admin only: `POST /usuarios/:id/asignaciones` (adds
  one row, or reactivates an inactive one on the same target) and
  `PATCH /usuarios/:id/asignaciones/:asignacionId` (keys and/or `estado` of one
  row). Each write and its audit entry commit in one Mongo transaction.
- `POST /usuarios` writes the first assignment and its audit entry (with
  `detalle`) in one transaction.
- `PATCH /usuarios/:id` becomes account-only (`nombre`,
  `esAdministradorPlataforma`, `estado`, `nuevaPassword`). `alcance`, the target
  ids, `permisos` and `perfil` are rejected with 400, and `Usuario.asignacion`
  is removed from the contract. `CrearUsuarioDto` loses `perfil`.

## Pasos por ambiente

**None.** No data migration, no index, no env var, no seed. The existing unique
indexes already allow one row per account and target, and the new endpoints
reuse them. Nothing here is checked by `GET /health/ready`, because there is
nothing to check.

## Deploy order

This package must deploy **after** `equipo-delegacion` (`equipo-delegacion.md`):
it reuses the catalog check and key diff from `casl/delegacion.ts` and writes
audit entries with the `detalle { agregadas, quitadas }` shape that release
introduced.

Then, in three steps (expand, move, contract):

1. **Backend, up to and including `eb7a248`** (expand). Additive: the new list
   and the two per-row routes exist, and the legacy `PATCH /usuarios/:id`
   behaves as before.
2. **Frontend.** It reads `asignaciones[]` and uses the per-row routes, and its
   account form no longer sends `alcance`, target ids, `permisos` or `perfil`.
3. **Backend `bbbff07`** (contract removal), **at least one working day after
   the frontend**, so tabs opened before the frontend deploy have reloaded
   (`dist/version.json` identifies the build in a given browser).

Why the gap: once `bbbff07` is live, the old frontend's save sends the legacy
fields on `PATCH /usuarios/:id` and the whitelist answers 400. Deploying the
removal before the frontend, or while old tabs are still open, breaks saving in
the platform Usuarios screen.

## Rollback

Reverse order, and the contract removal goes first:

1. Revert `bbbff07` **before** rolling back the frontend. Reverting the removal
   alone restores the legacy `PATCH /usuarios/:id`. Rolling the frontend back
   while `bbbff07` is live leaves the old form saving against a backend that
   answers it 400.
2. Roll back the frontend.
3. Only then, if needed, the earlier backend commits. There is no schema change,
   so every stored row stays valid, and the audit entries already written stay
   readable.

## Checking it by hand

- After step 1: `GET /usuarios/:id` carries `asignaciones` (and still
  `asignacion`).
- After step 3: `GET /usuarios/:id` has no `asignacion`, and a `PATCH` carrying
  `alcance` or `permisos` answers 400.
- A new assignment, a key edit and a deactivation each leave an audit entry
  (`entidadTipo: 'usuario'`, `accion` `crear`, `actualizar`, `retirar`) with
  `detalle`.
