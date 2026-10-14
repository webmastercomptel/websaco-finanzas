// src/modules/copropiedades/websaco3-copropiedad-id.ts

/**
 * Format of `Copropiedad.websaco3CopropiedadId`: exactly 24 hex characters,
 * either case.
 *
 * Deliberately NOT `isMongoId` / `@IsMongoId`: validator's `isHexadecimal`
 * allows an optional `0x`/`0h` prefix, so `'0x' + 22 hex chars` (24 characters
 * long) passes as a "Mongo id" yet is not a real ObjectId and would be
 * published as the link to the building-management system. Both the DTO and
 * the service use this one regex so the two layers can never disagree. Any
 * client-side check of this id must use the same pattern.
 */
export const WEBSACO3_COPROPIEDAD_ID_REGEX = /^[0-9a-f]{24}$/i;
