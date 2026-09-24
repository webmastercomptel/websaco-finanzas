# Building Management Activation Specification

## Purpose

Governs the domain validation that gates the `usesBuildingManagement` flag on
a `Copropiedad`. This flag is what a coproperty's own data controls to opt
into the outbound publishing edge described in `invoice-batch-publication`;
the two capabilities are independent, but this one is the precondition the
other depends on.

## Requirements

### Requirement: NIT completeness on activation

The system MUST reject any create or update request that would leave a
coproperty with `usesBuildingManagement: true` and an incomplete NIT
(`taxId` + `taxIdVerificationDigit` not both present), raising
`BadRequestException`. Completeness is evaluated against the RESULTING
document — the incoming DTO fields merged onto the currently stored
document — not the DTO alone.

#### Scenario: Create with flag true and no NIT

- GIVEN a request to create a coproperty
- WHEN the DTO sets `usaGestionEdificios: true` and omits both `nit` and `digitoVerificacion`
- THEN the system rejects the request with `BadRequestException`

#### Scenario: Create with flag true and complete NIT

- GIVEN a request to create a coproperty
- WHEN the DTO sets `usaGestionEdificios: true`, `nit`, and `digitoVerificacion`
- THEN the system creates the coproperty with `usesBuildingManagement: true`

#### Scenario: Update activates the flag and supplies the NIT in the same request

- GIVEN an existing coproperty with `usesBuildingManagement: false` and no NIT on file
- WHEN an update sets `usaGestionEdificios: true` together with `nit` and `digitoVerificacion`
- THEN the system accepts the update

#### Scenario: Update activates the flag but the NIT is already on file

- GIVEN an existing coproperty that already has `taxId` and `taxIdVerificationDigit` on file, with `usesBuildingManagement: false`
- WHEN an update sets `usaGestionEdificios: true` and does not include `nit` or `digitoVerificacion`
- THEN the system accepts the update, using the NIT already stored

#### Scenario: Update activates the flag with no NIT anywhere

- GIVEN an existing coproperty with no `taxId`/`taxIdVerificationDigit` on file, with `usesBuildingManagement: false`
- WHEN an update sets `usaGestionEdificios: true` and does not include `nit` or `digitoVerificacion`
- THEN the system rejects the update with `BadRequestException`

#### Scenario: Update does not touch the flag

- GIVEN an existing coproperty with `usesBuildingManagement: true` and a complete NIT already on file
- WHEN an update omits `usaGestionEdificios` entirely and also omits `nit`/`digitoVerificacion`
- THEN the system accepts the update — this validation MUST NOT run when the request does not touch the flag

#### Scenario: Verification digit of zero counts as present

- GIVEN a request that activates the flag
- WHEN `digitoVerificacion` is explicitly `0`
- THEN the system treats the verification digit as present, not missing
