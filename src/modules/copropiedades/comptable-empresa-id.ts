// src/modules/copropiedades/comptable-empresa-id.ts

/**
 * Format of `Copropiedad.comptableEmpresaId`: exactly 24 hex characters,
 * either case (stored lowercase). Not `@IsMongoId`, for the same `0x`-prefix
 * reason documented on `WEBSACO3_COPROPIEDAD_ID_REGEX`; the DTO and the
 * service share this one regex.
 */
export const COMPTABLE_EMPRESA_ID_REGEX = /^[0-9a-f]{24}$/i;
