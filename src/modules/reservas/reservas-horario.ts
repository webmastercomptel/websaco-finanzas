// src/modules/reservas/reservas-horario.ts
//
// Pure time helpers of the reservations module. Every clock label here is UTC,
// as in the system this replaces: the web client sends the wall-clock time the
// person picked as if it were UTC, so reading it back in UTC reproduces what
// they typed. Colombia is UTC-5, so do NOT "fix" this to a local timezone
// without changing the client in the same release.

export const MS_POR_MINUTO = 60_000;
export const MS_POR_HORA = 60 * MS_POR_MINUTO;

/**
 * Longest booking accepted. It exists because of `franjasDe`: every minute is
 * indexed, so the cap bounds the array (1440 entries) the double-booking guard
 * stores per reservation. The system this replaces had no cap.
 */
export const DURACION_MAXIMA_MS = 24 * MS_POR_HORA;

/** Hours before the start a resident may still cancel their own booking. */
export const HORAS_MINIMAS_PARA_CANCELAR = 6;

/** Operating hours assumed when a zone's free-text schedule has no `HH:MM - HH:MM`. */
export const HORARIO_OPERACION_POR_DEFECTO = {
  inicio: '06:00',
  fin: '22:00',
} as const;

/**
 * Every UTC minute `[inicio, fin)` touches, as minutes since the epoch. The
 * start is floored and the end ceiled, so a sub-minute edge can only make two
 * bookings conflict, never let them overlap. Two bookings of one zone overlap
 * exactly when they share a minute, which is what the unique index on
 * `(zonaId, franjas)` turns into a hard database guarantee.
 */
export const franjasDe = (inicio: Date, fin: Date): number[] => {
  const desde = Math.floor(inicio.getTime() / MS_POR_MINUTO);
  const hasta = Math.ceil(fin.getTime() / MS_POR_MINUTO);
  const franjas: number[] = [];
  for (let minuto = desde; minuto < hasta; minuto += 1) franjas.push(minuto);
  return franjas;
};

/** `HH:MM` of an instant, in UTC. */
export const horaUtc = (fecha: Date): string =>
  `${String(fecha.getUTCHours()).padStart(2, '0')}:${String(
    fecha.getUTCMinutes(),
  ).padStart(2, '0')}`;

/** "HH:MM - HH:MM" label of a start/end pair, in UTC. */
export const formatearRangoUtc = (inicio: Date, fin: Date): string =>
  `${horaUtc(inicio)} - ${horaUtc(fin)}`;

/** Whether `ahora` falls inside `[inicio, fin)`. */
export const estaEnCurso = (ahora: Date, inicio: Date, fin: Date): boolean =>
  ahora >= inicio && ahora < fin;

/**
 * Operating hours out of a zone's free-text schedule ("Lunes a viernes
 * 08:00 - 20:00"): the first `HH:MM - HH:MM` found, or the default range when
 * there is none. Informational: bookings are not rejected for falling outside.
 */
export const horarioDeOperacion = (
  horario: string,
): { inicio: string; fin: string } => {
  const coincidencia = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(horario);
  if (!coincidencia) return { ...HORARIO_OPERACION_POR_DEFECTO };
  return { inicio: coincidencia[1], fin: coincidencia[2] };
};
