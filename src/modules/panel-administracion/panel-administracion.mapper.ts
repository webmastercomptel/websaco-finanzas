// src/modules/panel-administracion/panel-administracion.mapper.ts
import type { Types } from 'mongoose';
import { toIso } from '../../common/utils/mapper.utils';
import type {
  ComunicacionPanel,
  ResumenPanelAdministracion,
} from '../../contracts';

/**
 * Mongo `$dayOfWeek` (1 = Sunday … 7 = Saturday) -> chart label. Sunday is left
 * out on purpose: the chart this was ported from drew Monday to Saturday only.
 */
export const DIAS_SEMANA: ReadonlyArray<{ clave: number; etiqueta: string }> = [
  { clave: 2, etiqueta: 'Lun' },
  { clave: 3, etiqueta: 'Mar' },
  { clave: 4, etiqueta: 'Mié' },
  { clave: 5, etiqueta: 'Jue' },
  { clave: 6, etiqueta: 'Vie' },
  { clave: 7, etiqueta: 'Sáb' },
];

/** Chars of an announcement body kept as the dashboard teaser. */
export const LONGITUD_RESUMEN_COMUNICACION = 120;

/** Fields of an announcement the dashboard reads (the rest is never selected). */
export interface FilaComunicacion {
  _id: Types.ObjectId;
  categoria: string;
  titulo: string;
  publicadoEn: Date | null;
  contenido?: string;
}

/** A `$group` row of the weekday aggregation. */
export interface FilaDiaSemana {
  _id: number;
  n: number;
}

/** A `$group` row of the bookings-by-state aggregation. */
export interface FilaEstadoReserva {
  _id: string;
  n: number;
}

/** Announcement row -> dashboard teaser. */
export const toComunicacion = (fila: FilaComunicacion): ComunicacionPanel => ({
  id: fila._id.toString(),
  tipo: fila.categoria,
  titulo: fila.titulo,
  fecha: toIso(fila.publicadoEn) ?? undefined,
  descripcion: fila.contenido?.slice(0, LONGITUD_RESUMEN_COMUNICACION),
});

/**
 * Weekday groups -> the six-bar chart. Every day is present even with no PQR,
 * so a permitted-but-empty chart is six zeros, not a missing block.
 */
export const toPqrSemanal = (
  filas: readonly FilaDiaSemana[],
): NonNullable<ResumenPanelAdministracion['pqrSemanal']> => {
  const porDia = new Map(filas.map((f) => [f._id, f.n]));
  return DIAS_SEMANA.map((d) => ({
    dia: d.etiqueta,
    valor: porDia.get(d.clave) ?? 0,
  }));
};

/**
 * Bookings grouped by state -> approved share. With no bookings at all there is
 * nothing to take a percentage of, so it reads 0 / "Sin datos" instead of
 * inventing a figure.
 */
export const toOcupacionReservas = (
  filas: readonly FilaEstadoReserva[],
): NonNullable<ResumenPanelAdministracion['reservas']> => {
  const total = filas.reduce((suma, f) => suma + f.n, 0);
  const aprobadas = filas.find((f) => f._id === 'aprobada')?.n ?? 0;
  const ocupacion = total > 0 ? Math.round((aprobadas / total) * 100) : 0;
  return {
    ocupacion,
    etiqueta:
      total === 0 ? 'Sin datos' : ocupacion >= 70 ? 'Alta demanda' : 'Normal',
  };
};
