// src/common/correo/texto-correo.ts

/**
 * Escapes the four HTML-significant characters. Every untrusted string (a title
 * a user typed, a person's name) goes through this before it is interpolated
 * into an email template literal.
 */
export const escapeHtml = (valor: string): string =>
  valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * A booking time for email copy. Bookings store the Bogotá wall clock written
 * as UTC (see `common/utils/reloj-bogota.ts`), so it is printed in UTC: 21:00
 * typed reads 21:00, not the 16:00 that `formatFecha` would show.
 */
export const formatFechaRelojDePared = (fecha: Date): string =>
  new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(fecha);

/**
 * A calendar day stored as UTC midnight (an activity's `fecha`), with no time:
 * printed in UTC so it is never the previous day at 19:00.
 */
export const formatDiaUtc = (fecha: Date): string =>
  new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(fecha);

/**
 * A REAL instant (a publication time, a creation time) for email copy, in the
 * product's locale and timezone (Colombia). Never for a stored wall-clock time
 * or a UTC-midnight day: use the two formatters above for those.
 */
export const formatFecha = (fecha: Date): string =>
  new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(fecha);
