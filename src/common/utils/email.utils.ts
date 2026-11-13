// src/common/utils/email.utils.ts
import { createHash } from 'node:crypto';

// Same shape class-validator's own `IsEmail` accepts by default — kept as a
// plain regex here because the bulk import validates outside the DTO
// pipeline (one column, many addresses, one row failing must not fail the
// whole file — see `InmueblesService.importar`).
const PATRON_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Single source of truth for "is this a usable address" so the bulk import and
 * the resident-provisioning path can never disagree on what counts as valid.
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
 * same pattern `InmueblesService.validarFila` already uses for a bad
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

/**
 * How many addresses one party (`Tercero`) may carry. The DTO's
 * `@ArrayMaxSize` and the import share this constant; the frontend mirrors it.
 * It is enforced when addresses are WRITTEN: legacy lists above it are read
 * whole by the invoice recipients resolver.
 */
export const MAX_CORREOS_POR_TERCERO = 5;

/** Thrown by `normalizarListaEmails` when a cell holds too many DISTINCT
 *  addresses, so a caller can tell it from a malformed one and name the party. */
export class DemasiadosCorreosError extends Error {
  constructor() {
    super(`Máximo ${MAX_CORREOS_POR_TERCERO} correos`);
    this.name = 'DemasiadosCorreosError';
  }
}

/** The one normal form of an address: trimmed and lowercased. */
export function normalizarEmail(valor: string): string {
  return valor.trim().toLowerCase();
}

/**
 * The only identity of an address in stored records: SHA-256 hex of the
 * normalized address under a versioned prefix. It keeps addresses out of logs
 * and delivery records; it is pseudonymization, not anonymity (an unsalted
 * hash of an e-mail can be reversed with a dictionary).
 */
export function claveCorreo(email: string): string {
  return createHash('sha256')
    .update(`correo:v1:${normalizarEmail(email)}`)
    .digest('hex');
}

/**
 * `parseEmails` plus the rules every write path needs: case-insensitive
 * deduplication (first spelling kept, order kept) and a cap of
 * `MAX_CORREOS_POR_TERCERO` DISTINCT addresses, counted after deduplication.
 * Throws `DemasiadosCorreosError` over the cap and the usual «"x" no es un
 * correo válido» error for a malformed entry.
 */
export function normalizarListaEmails(valor: string | undefined): string[] {
  const vistos = new Set<string>();
  const unicos: string[] = [];
  for (const correo of parseEmails(valor)) {
    const normal = normalizarEmail(correo);
    if (vistos.has(normal)) continue;
    vistos.add(normal);
    unicos.push(correo);
  }
  if (unicos.length > MAX_CORREOS_POR_TERCERO) {
    throw new DemasiadosCorreosError();
  }
  return unicos;
}

/**
 * Masks an address for logs: first character of the local part, `***`, then
 * the domain (`juan@x.co` -> `j***@x.co`). A value without `@` (or with an
 * empty local part) becomes `***`, never raw.
 */
export function enmascararEmail(email: string): string {
  const arroba = email.lastIndexOf('@');
  if (arroba < 1) return '***';
  return `${email.charAt(0)}***${email.slice(arroba)}`;
}
