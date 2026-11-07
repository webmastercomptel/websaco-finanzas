// src/modules/integraciones-panel/id-registro.ts

/**
 * Format of any record id the panel sends or receives: exactly 24 hex
 * characters, either case. Not `@IsMongoId`: validator's hex check accepts a
 * `0x` prefix, so a 24-character `0x…` string would pass as an ObjectId.
 */
export const ID_REGISTRO_REGEX = /^[0-9a-f]{24}$/i;

/** Ids are stored and compared trimmed and lowercase. */
export const normalizarId = (id: string): string => id.trim().toLowerCase();
