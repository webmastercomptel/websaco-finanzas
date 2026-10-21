// src/common/utils/email.utils.ts

// Same shape class-validator's own `IsEmail` accepts by default — kept as a
// plain regex here because the bulk import validates outside the DTO
// pipeline (one column, many addresses, one row failing must not fail the
// whole file — see `InmueblesService.importar`).
const PATRON_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Single source of truth for "is this a usable address" so the bulk import and
 * the WebSaco3 holders snapshot can never disagree on what counts as valid.
 * Deliberately lax and WITHOUT trimming: callers trim first, and a blank or
 * whitespace-padded value is invalid by the pattern itself.
 */
export function esEmailValido(valor: string): boolean {
  return PATRON_EMAIL.test(valor);
}

/**
 * Splits one spreadsheet cell into the list `Tercero.emails` stores.
 *
 * The bulk-import template has a single "Email" column, but a party often
 * answers to more than one inbox (owner and property manager, co-owners) —
 * comma or semicolon separated, whichever the file happens to use. Throws
 * on the first malformed address so the row fails with a clear message,
 * same pattern `InmueblesService.resolverTitular` already uses for a bad
 * DIAN/DANE catalog code — caught by that row's own try/catch, never the
 * whole import.
 */
export function parseEmails(valor: string | undefined): string[] {
  if (!valor) return [];

  const correos = valor
    .split(/[,;]/)
    .map((c) => c.trim())
    .filter(Boolean);

  const invalido = correos.find((c) => !esEmailValido(c));
  if (invalido) {
    throw new Error(`"${invalido}" no es un correo válido`);
  }

  return correos;
}

/**
 * Inverse of `parseEmails`: joins a party's addresses into one spreadsheet
 * cell. Uses a comma — one of the separators `parseEmails` splits on, and one
 * no stored address can contain (the import splits on it BEFORE validating, so
 * an address with a comma never gets in) — so `parseEmails(formatEmails(x))`
 * returns `x` and an exported file loads back unchanged.
 */
export function formatEmails(emails: readonly string[] | undefined): string {
  return (emails ?? []).join(', ');
}
