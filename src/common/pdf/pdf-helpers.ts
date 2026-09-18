/** Formats a number as Colombian peso currency: $ 1.234.567 — thousands
 *  separated by ".", never a decimal (`maximumFractionDigits: 0` pinned
 *  explicitly rather than left to the locale default, so a float-rounding
 *  artifact upstream can never sneak stray cents onto a printed document). */
export function formatoPeso(valor: number): string {
  return `$ ${valor.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}

/** Appends "(A Favor)" to an already-`formatoPeso`-formatted value when the
 *  raw number behind it is negative — Estado de Cuenta's own "Saldo actual"
 *  row is the only caller: a negative `saldoActual` there is a real credit
 *  balance the propietario is owed, not an error state, and the sign itself
 *  is never flipped (the printed figure still literally matches the number).
 *  Wraps `formatoPeso` rather than living inside it — every OTHER caller of
 *  `formatoPeso` still wants the plain peso string, never this suffix. */
export function formatoSaldoConFavor(valor: number): string {
  return valor < 0 ? `${formatoPeso(valor)} (A Favor)` : formatoPeso(valor);
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

const FORMATO_FECHA_HORA = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'America/Bogota',
});

/** Formats a live instant (`new Date()` at generation time — never a stored
 *  business date, that's `formatoFecha`'s job) as `dd/mm/yyyy HH:mm:ss`,
 *  pinned to `America/Bogota` so it reads correctly for a Colombian reader
 *  regardless of which timezone Cloud Run actually runs the process in.
 *  Used by every "informe" (report/listing) PDF to stamp exactly when it
 *  was produced — a live snapshot re-generated later could show different
 *  numbers, and this timestamp is what keeps that honest. */
export function formatoFechaHora(fecha: Date): string {
  return FORMATO_FECHA_HORA.format(fecha);
}
