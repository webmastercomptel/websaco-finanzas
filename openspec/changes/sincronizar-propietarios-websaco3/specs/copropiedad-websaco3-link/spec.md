# Delta for Copropiedad WebSaco3 Link

Builds on `publicar-facturas-vinculo-id` (`building-management-activation`): `websaco3CopropiedadId` is 24-hex, stored trimmed and lowercase, non-null if and only if `usaGestionEdificios` is true.

## ADDED Requirements

### Requirement: websaco3CopropiedadId is unique when set

No two coproperties MAY hold the same `websaco3CopropiedadId`. Uniqueness MUST be case-insensitive (values are stored lowercase, and the service MUST normalize with trim + lowercase before comparing or storing). Coproperties with `null` (or no key) MUST NOT collide with each other. The rule MUST be enforced twice: a write-time check in `CopropiedadesService` (`create` and `update`) answering `409 Conflict` with a Spanish message, and a unique index as the safety net.

#### Scenario: Create with a free id

- GIVEN no coproperty holds `64b7f0c2a1d4e5f6a7b8c9d0`
- WHEN a create sets `usaGestionEdificios: true` and that id
- THEN the coproperty is created

#### Scenario: Create with an id already in use

- GIVEN coproperty A holds `64b7f0c2a1d4e5f6a7b8c9d0`
- WHEN a create or an update of another coproperty sets the same id
- THEN the response is `409` and nothing is written

#### Scenario: Same id in different case

- GIVEN coproperty A holds `64b7f0c2a1d4e5f6a7b8c9d0`
- WHEN another coproperty is saved with `64B7F0C2A1D4E5F6A7B8C9D0`
- THEN the response is `409`

#### Scenario: Updating a coproperty that already holds the id

- GIVEN coproperty A holds the id
- WHEN A is updated (same id resent, or id omitted)
- THEN the update succeeds; A never collides with itself

#### Scenario: Many coproperties without id

- GIVEN several coproperties with `websaco3CopropiedadId: null` (or the key absent)
- WHEN any of them is saved
- THEN no uniqueness error occurs

#### Scenario: Flag off clears the id

- GIVEN coproperty A holds the id and an update sets `usaGestionEdificios: false`
- WHEN the update completes
- THEN A's id is `null`, and the id becomes available for another coproperty

#### Scenario: Concurrent writers

- GIVEN two requests set the same free id at the same moment and both pass the write-time check
- WHEN the second write reaches the database
- THEN the unique index rejects it (E11000 on `websaco3CopropiedadId`) and the service answers `409`, not `500`

### Requirement: Index is a partial unique index managed by a script

The schema MUST declare `{ websaco3CopropiedadId: 1 }` unique with `partialFilterExpression: { websaco3CopropiedadId: { $type: 'string' } }` and the default name `websaco3CopropiedadId_1`. A script `scripts/migrate-copropiedad-websaco3-id-index.js` MUST first LIST duplicate ids (grouped by trimmed, lowercased value) and values that are not normalized, and MUST NOT create the index while duplicates exist (non-zero exit). When none exist it MUST create the index idempotently with the same name and options as the schema. It MUST write nothing else. The system MUST NOT depend on boot-time index creation to be correct.

#### Scenario: Duplicates present

- GIVEN two coproperties share an id (case-insensitively)
- WHEN the script runs
- THEN it prints each group (ids, codes, names), creates no index, and exits non-zero

#### Scenario: Clean data

- GIVEN no duplicates
- WHEN the script runs, and again a second time
- THEN the index exists after the first run and the second run reports "already exists" and changes nothing

#### Scenario: Application boots with duplicates still in data

- GIVEN duplicates exist and the index could not be built
- WHEN the application boots
- THEN boot is not blocked; the write-time check still prevents NEW duplicates; the holders endpoint answers `409` for a duplicated id
