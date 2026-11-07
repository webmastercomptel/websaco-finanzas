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

/** A date for email copy, in the product's locale and timezone (Colombia). */
export const formatFecha = (fecha: Date): string =>
  new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(fecha);
