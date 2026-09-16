/** Formats a number as Colombian peso currency: $ 1.234.567 — thousands
 *  separated by ".", never a decimal (`maximumFractionDigits: 0` pinned
 *  explicitly rather than left to the locale default, so a float-rounding
 *  artifact upstream can never sneak stray cents onto a printed document). */
export function formatoPeso(valor: number): string {
  return `$ ${valor.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}

const FORMATO_FECHA = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Formats a Date as dd/mm/yyyy, day and month always 2 digits (`05/01/2026`,
 *  never `5/1/2026`) — `Date#toLocaleDateString` doesn't zero-pad, which
 *  ragged a column of stacked dates whenever one had a single-digit day/month.
 *  Pinned to UTC — every date-only business date this app stores is midnight
 *  UTC to begin with (see the note in frontend's lote-definicion.tsx), so
 *  formatting in the server's local timezone would show the day before
 *  whenever that offset is negative (e.g. Cloud Run running in
 *  America/Bogota, UTC-5). */
export function formatoFecha(fecha: Date | string): string {
  return FORMATO_FECHA.format(new Date(fecha));
}
