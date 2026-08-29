// src/common/utils/query.utils.ts

/**
 * Escapes a user-supplied string so it is safe to drop into a MongoDB
 * `$regex` filter as a literal search term.
 *
 * A search box is user input. An unescaped value lets a stray `(` throw, or a
 * crafted pattern (catastrophic backtracking) pin the database at 100% CPU.
 * Every service that builds a `$regex` filter from a query parameter must
 * route it through here — never inline the pattern.
 */
export const escapeRegex = (texto: string): string =>
  texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
