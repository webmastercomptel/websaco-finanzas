// src/common/utils/reloj-bogota.ts
//
// The Administración modules store a booking's time (and an activity's day) as
// the WALL CLOCK of Bogotá written as if it were UTC: a booking for 21:00 is
// `…T21:00:00.000Z`, an activity on 10 Sep is `2026-09-10T00:00:00.000Z`. The
// web client sends them that way and reads them back in UTC, so the hour a
// person typed is always the hour shown. A REAL instant (`Date.now()`) is
// therefore 5 hours ahead of that scale, and comparing the two directly made
// every "is it in the future / still cancellable / already started / today"
// rule wrong by 5 hours.
//
// These helpers put "now" on the same scale. Why a constant and not a timezone
// library: Colombia is UTC-5 all year (no daylight saving since 1993), so the
// conversion is one subtraction, and the stored values are not instants anyway
// (a tz library would suggest they are).

/** Bogotá is UTC-5 the whole year: there is no daylight saving in Colombia. */
export const DESFASE_BOGOTA_MS = 5 * 60 * 60 * 1000;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * "Now" as the Bogotá wall clock written as UTC — the scale bookings are stored
 * in. Every comparison between a stored booking time and the present goes
 * through this. Reads `Date.now()` by default so tests can pin it.
 */
export const relojDeParedBogota = (instante: number = Date.now()): Date =>
  new Date(instante - DESFASE_BOGOTA_MS);

/**
 * Midnight of today's Bogotá day on the wall-clock-as-UTC scale: the start of
 * "today" for bookings (by their start) and for activity days.
 */
export const inicioDelDiaBogota = (instante: number = Date.now()): Date => {
  const pared = relojDeParedBogota(instante).getTime();
  return new Date(pared - (pared % MS_POR_DIA));
};
