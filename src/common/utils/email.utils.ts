// src/common/utils/email.utils.ts

// Same shape class-validator's own `IsEmail` accepts by default — kept as a
// plain regex here because the bulk import validates outside the DTO
// pipeline (one column, many addresses, one row failing must not fail the
// whole file — see `InmueblesService.importar`).
const PATRON_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const invalido = correos.find((c) => !PATRON_EMAIL.test(c));
  if (invalido) {
    throw new Error(`"${invalido}" no es un correo válido`);
  }

  return correos;
}
