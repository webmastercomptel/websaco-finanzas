# Delta for Inmueble Catalog

## ADDED Requirements

### Requirement: Inmueble.codigo is immutable after creation

Once an `Inmueble` exists, its `codigo` MUST NOT change through any edit path. The edit endpoint (`PATCH`/update in `InmueblesService.update`) MUST reject a different `codigo` with `400 Bad Request` and the Spanish message "El código de un inmueble no se puede modificar después de crearlo." The comparison is exact on the trimmed value (a case-only or whitespace-inside change is a change). A `codigo` equal to the stored one MUST be accepted and ignored (never written), so a form that resends the unchanged code keeps working. The tenant-scoped lookup runs first: a unit that does not exist in the active coproperty answers `404`, whatever `codigo` was sent. All other fields MUST remain editable. The unit-code duplicate check on update becomes unnecessary and MUST be removed.

#### Scenario: Different code on edit

- GIVEN unit `301` exists in the active coproperty
- WHEN an update sets `codigo: '302'`
- THEN the response is `400` with the immutability message and nothing is written

#### Scenario: Case-only change

- GIVEN unit `Torre A-301`
- WHEN an update sets `codigo: 'torre a-301'`
- THEN the response is `400`

#### Scenario: Unchanged code resent

- GIVEN unit `301`
- WHEN an update sends `codigo: '301'` (or `' 301 '`) together with `bloque: 'B'`
- THEN the update succeeds, `bloque` changes and `codigo` is not part of the `$set`

#### Scenario: Code omitted

- GIVEN unit `301`
- WHEN an update sends only `area: 70`
- THEN the update succeeds

#### Scenario: Unit of another coproperty

- GIVEN a unit id that belongs to another coproperty
- WHEN an update sends any `codigo`
- THEN the response is `404`

#### Scenario: Other fields stay editable

- GIVEN unit `301`
- WHEN an update changes `titularId`, `tipoTitular`, `estado` or `estadoCartera`
- THEN the update succeeds

### Requirement: Creation and import of new units keep working

`create` MUST still accept a `codigo` and keep rejecting a duplicate (case- and whitespace-insensitive) with `409`. The Excel import (`importar`) MUST keep creating units from its rows, and MUST NOT contain an update path: it never renames an existing `Inmueble`. A unit with a Factura survives the import's wipe untouched, so a row repeating its code fails that row with the existing duplicate-code error. Units without a Factura are deleted and recreated by the import as before (existing "replace the roster" semantics); this is not a rename.

#### Scenario: Create a new unit

- GIVEN no unit `401` exists
- WHEN a create sends `codigo: '401'`
- THEN it is created

#### Scenario: Create a duplicate

- GIVEN unit `301` exists
- WHEN a create sends `codigo: ' 301 '`
- THEN the response is `409`

#### Scenario: Import loads new rows

- GIVEN a valid file with new codes
- WHEN it is imported
- THEN the units are created as before

#### Scenario: Import row repeats the code of a billed unit

- GIVEN unit `301` has a Factura and therefore survives the import wipe
- WHEN the file contains a row with code `301`
- THEN that row reports the duplicate-code error, `301` keeps its `_id` and data, and no other unit is renamed

### Requirement: Frontend code field is read-only on edit

The inmueble form MUST render the code field disabled when editing an existing unit, with help text stating that the code cannot be changed after creation, and MUST send the stored code unchanged. On creation the field stays editable and required.

#### Scenario: Editing

- GIVEN the form opened for an existing unit
- WHEN it renders
- THEN the "Inmueble" field is disabled with the help text, and saving sends the stored `codigo`

#### Scenario: Creating

- GIVEN the form opened for a new unit
- WHEN it renders
- THEN the "Inmueble" field is editable and required
