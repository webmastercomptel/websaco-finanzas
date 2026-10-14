# Delta for Building Management Activation

## ADDED Requirements

### Requirement: WebSaco3 coproperty id required on activation

The system MUST reject any create or update that would leave a coproperty
with `usaGestionEdificios: true` and no valid `websaco3CopropiedadId`
(24-hex ObjectId string, case-insensitive), raising `BadRequestException`.
Validity is evaluated against the RESULTING document (incoming DTO fields
merged onto the stored document). The DTO MUST validate the format; the
service MUST re-check it. NIT and `digitoVerificacion` MUST NOT be required
for activation.

#### Scenario: Create with flag true and a valid id

- GIVEN a request to create a coproperty
- WHEN the DTO sets `usaGestionEdificios: true` and `websaco3CopropiedadId: "64b7f0c2a1d4e5f6a7b8c9d0"`, with no `nit`
- THEN the system creates the coproperty

#### Scenario: Flag true with missing id

- GIVEN a create, or an update on a coproperty with no id on file
- WHEN the request sets `usaGestionEdificios: true` without `websaco3CopropiedadId`
- THEN the system rejects the request with `BadRequestException`

#### Scenario: Flag true with malformed id

- GIVEN a request that activates the flag
- WHEN `websaco3CopropiedadId` is not 24 hex characters (e.g. `"123"` or `"zzzzzzzzzzzzzzzzzzzzzzzz"`)
- THEN the request is rejected by DTO validation

#### Scenario: Activation reuses the stored id

- GIVEN a coproperty with `usaGestionEdificios: false` and a valid id on file
- WHEN an update sets `usaGestionEdificios: true` without sending the id
- THEN the system accepts the update

#### Scenario: Update does not touch the flag

- GIVEN a coproperty with `usaGestionEdificios: true` and a valid id on file
- WHEN an update omits `usaGestionEdificios` and `websaco3CopropiedadId`
- THEN the system accepts the update; the id rule MUST NOT run

### Requirement: Id is cleared when the flag is turned off

When a create or update leaves `usaGestionEdificios: false`, the system MUST
ignore any supplied `websaco3CopropiedadId` and MUST clear the stored one.

#### Scenario: Deactivation clears the id

- GIVEN a coproperty with `usaGestionEdificios: true` and an id on file
- WHEN an update sets `usaGestionEdificios: false`
- THEN the stored `websaco3CopropiedadId` is cleared

#### Scenario: Id supplied while the flag is off

- GIVEN a request that leaves `usaGestionEdificios: false`
- WHEN it includes a valid `websaco3CopropiedadId`
- THEN the system accepts the request and does not store the id

### Requirement: Frontend id input

The coproperty form MUST show a `websaco3CopropiedadId` input only while the
flag is on, with the helper text "Copiá el ID desde WebSaco3 > Configuración >
Copropiedades > Ver detalle", and MUST block submit on an invalid id.

#### Scenario: Input visibility and client-side check

- GIVEN the coproperty form
- WHEN the checkbox is off, the input is hidden; WHEN it is on and the value is not 24-hex, submit is blocked with an inline error

## REMOVED Requirements

### Requirement: NIT completeness on activation

(Reason: the integration links by `websaco3CopropiedadId` only. The NIT
remains a regular coproperty field but no longer gates `usaGestionEdificios`.
Replaced by "WebSaco3 coproperty id required on activation".)
