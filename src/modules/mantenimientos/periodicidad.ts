// src/modules/mantenimientos/periodicidad.ts
import type { PeriodicidadMantenimiento } from '../../database/schemas/administracion/mantenimiento.schema';

/** Months added by each calendar-based cadence. */
const MESES: Record<Exclude<PeriodicidadMantenimiento, 'semanal'>, number> = {
  mensual: 1,
  semestral: 6,
  anual: 12,
};

/**
 * Date of the next occurrence: the scheduled date plus one period, computed in
 * UTC so the business date never shifts with the server's zone. A day that
 * does not exist in the target month is clamped to its last day (31 Jan + 1
 * month = 28/29 Feb). Pure: returns a new Date, never mutates its input.
 */
export function siguienteFecha(
  fecha: Date,
  periodicidad: PeriodicidadMantenimiento,
): Date {
  if (periodicidad === 'semanal') {
    return new Date(fecha.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  const total = fecha.getUTCMonth() + MESES[periodicidad];
  const anio = fecha.getUTCFullYear() + Math.floor(total / 12);
  const mes = total % 12;
  const ultimoDia = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  const resultado = new Date(fecha.getTime());
  resultado.setUTCFullYear(anio, mes, Math.min(fecha.getUTCDate(), ultimoDia));
  return resultado;
}
