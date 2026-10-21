# Proposal: Inmuebles bulk import as an upsert that never deletes

## Intent

Loading a roster file must never be destructive. The old import wiped every unit before loading, which is non-atomic (a bad row left its unit deleted and not recreated), guarded only against `Factura` although Recibo, SaldoInicial, SaldoInicialAnticipo, notas and SaldoCartera also reference `inmuebleId` (so a unit holding only opening balances or receipts could be hard-deleted and orphan them), minted new `_id`s on every run, and made invoiced units impossible to correct.

## Decision (user and product owner, 2026-10-21)

Single behavior, no mode switch: `POST /inmuebles/importar` is an **upsert by code that never deletes**. This REVERSES decision D15 of `sincronizar-propietarios-websaco3` ("no code change in `importar`, match-by-code upsert rejected"); dated notes were added there.

## What changed

- Existing code (tenant-scoped, case/whitespace-insensitive): patch only the fields the row sent. Blank or whitespace-only cells count as not sent, for the unit and the titular. `codigo` and `estado` are never written. No invoice guard (nothing is deleted).
- New code: created exactly as before (`propietario`, not resident, `vigente`).
- Titular, with an identification: a Tercero that has it is refreshed and assigned (how a unit changes hands). If none has it, the unit's current Tercero receives it only when that Tercero has no identification yet and the name is the same person's (filling in missing papers does not duplicate the owner); otherwise a NEW Tercero is created and the old owner is never renamed. No name to create it from: row error.
- Titular, without identification: the same person (name equals the stored `nombre` or the composition of its parts; trim, case, spaces) is refreshed in place, even if shared, so re-importing an unedited export is a no-op. A different name creates a new Tercero when the stored one has an identification (a sale with the cell left empty), and otherwise refreshes it in place only if no other unit shares it. No titular data: untouched. Name parts are only written with a recomputed `nombre`, clearing the opposite person-type set when the type flips.
- Rows are best-effort atomic: a Tercero created by a row is deleted if that row then fails; an existing unit's patch is not rolled back (no Mongo transactions). `null` counts as a blank cell; E11000 reads "Código duplicado" or "Identificación duplicada" by key. A Tercero created by a failed row is kept if a unit already points at it.
- Whole-file `codigoCopropiedad` check still aborts first with zero writes.
- Removed `InmueblesEliminacionService.eliminarTodosEliminables` and its dependency; single `DELETE :id` is untouched.
- New read endpoint `GET /inmuebles/exportar-importacion` returns the roster in the import's exact 25-column shape, so the file round-trips.

## Contract

- `ResultadoImportacionInmuebles` adds `actualizados`. `creados` keeps meaning created.
- `eliminadosAntes` (always 0) and `bloqueadosPorFactura` (always `[]`) stay `@deprecated` for one release so an older frontend keeps parsing.
- `GET /inmuebles/exportar-importacion` -> `data: { copropiedadCodigo, filas[25 columns] }`. Requires read `Inmueble` AND read `Tercero` (personal data of every owner). `POST /inmuebles/importar` and `importar/progreso` now require create AND update `Inmueble` (not `update Tercero`: the titular refresh already existed under the old gate and could lock out the accountant role). No new permission keys.

## Deploy order

Backend first, then frontend. A new frontend against an old backend would show no `actualizados` (and the old backend still wipes).

## Deferred: phase 2 (not in this change)

- Preview / dry run ("se crearán N, se actualizarán M") that writes nothing, not even new Terceros.
- Explicit "dar de baja los ausentes": logical retirement (`estado: 'inactivo'`) behind a confirmation, never a delete.
- Optional: allow renaming `codigo` only for units without any financial document.
- Follow-up, skipped on purpose: a non-numeric `area` still rejects the whole file (pre-existing DTO behavior, out of scope).
- Follow-up, skipped on purpose: no audit entry for the roster export (not requested; revisit with the personal-data policy).
- Follow-up, skipped on purpose: single `DELETE :id` still guards only `Factura` and can orphan other `inmuebleId` references (pre-existing, same flaw as the old wipe).
- Known limitation: if all units sharing one Tercero get the same NEW name with no identification, the result depends on row order (the last row finds it unshared and renames in place). Fix: an in-file name-to-id reuse map.
