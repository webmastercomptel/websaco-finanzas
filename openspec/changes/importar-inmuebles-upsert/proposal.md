# Proposal: Inmuebles bulk import as an upsert that never deletes

## Intent

Loading a roster file must never be destructive. The old import wiped every unit before loading, which is non-atomic (a bad row left its unit deleted and not recreated), guarded only against `Factura` although Recibo, SaldoInicial, SaldoInicialAnticipo, notas and SaldoCartera also reference `inmuebleId` (so a unit holding only opening balances or receipts could be hard-deleted and orphan them), minted new `_id`s on every run, and made invoiced units impossible to correct.

## Decision (user and product owner, 2026-10-21)

Single behavior, no mode switch: `POST /inmuebles/importar` is an **upsert by code that never deletes**. This REVERSES decision D15 of `sincronizar-propietarios-websaco3` ("no code change in `importar`, match-by-code upsert rejected"); dated notes were added there.

## What changed

- Existing code (tenant-scoped, case/whitespace-insensitive): patch only the fields the row sent. Blank or whitespace-only cells count as not sent, for the unit and the titular. `codigo` and `estado` are never written. No invoice guard (nothing is deleted).
- New code: created exactly as before (`propietario`, not resident, `vigente`).
- Titular on update: identification present, the matching Tercero of the coproperty is refreshed and assigned (a unit changes hands this way). No identification but a name: the unit's own Tercero is refreshed only when no other unit shares it, otherwise a new Tercero is created. No titular data: untouched.
- Whole-file `codigoCopropiedad` check still aborts first with zero writes.
- Removed `InmueblesEliminacionService.eliminarTodosEliminables` and its dependency; single `DELETE :id` is untouched.
- New read endpoint `GET /inmuebles/exportar-importacion` returns the roster in the import's exact 25-column shape, so the file round-trips.

## Contract

- `ResultadoImportacionInmuebles` adds `actualizados`. `creados` keeps meaning created.
- `eliminadosAntes` (always 0) and `bloqueadosPorFactura` (always `[]`) stay `@deprecated` for one release so an older frontend keeps parsing.
- `GET /inmuebles/exportar-importacion` -> `data: { copropiedadCodigo, filas[25 columns] }`. Requires read `Inmueble` AND read `Tercero` (personal data of every owner). No new permission keys.

## Deploy order

Backend first, then frontend. A new frontend against an old backend would show no `actualizados` (and the old backend still wipes).

## Deferred: phase 2 (not in this change)

- Preview / dry run ("se crearán N, se actualizarán M") that writes nothing, not even new Terceros.
- Explicit "dar de baja los ausentes": logical retirement (`estado: 'inactivo'`) behind a confirmation, never a delete.
- Optional: allow renaming `codigo` only for units without any financial document.
