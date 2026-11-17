import { Types } from 'mongoose';
import {
  ESTADOS_PQR,
  ESTADOS_PQR_LEGADOS,
  type EstadoPqr,
  type EventoPqr,
  type TipoEventoPqr,
} from '../../database/schemas/administracion/pqr.schema';

/**
 * Stored values that mean each stage. Legacy values stay readable until the
 * data conversion runs, so every query and every read goes through here
 * instead of comparing raw strings.
 */
const VALORES_POR_ESTADO: Record<EstadoPqr, readonly string[]> = {
  radicada: ['radicada', 'pendiente'],
  clasificada: ['clasificada'],
  en_gestion: ['en_gestion', 'en_revision', 'urgente'],
  cerrada: ['cerrada', 'resuelto', 'cerrado'],
};

/** The stage a stored `estado` value stands for; unknown reads as `radicada`. */
export const estadoActual = (valor: string): EstadoPqr => {
  for (const estado of ESTADOS_PQR) {
    if (VALORES_POR_ESTADO[estado].includes(valor)) return estado;
  }
  return 'radicada';
};

/** Every stored value that means `estado` (current and legacy). */
export const valoresDeEstado = (estado: EstadoPqr): string[] => [
  ...VALORES_POR_ESTADO[estado],
];

/** Stored values meaning «cerrada». */
export const VALORES_CERRADOS: string[] = valoresDeEstado('cerrada');

/** Every other stored value (the PQR is still open). */
export const VALORES_ABIERTOS: string[] = [
  ...ESTADOS_PQR,
  ...ESTADOS_PQR_LEGADOS,
].filter((valor) => !VALORES_CERRADOS.includes(valor));

/**
 * Overdue = still open and the deadline day is strictly before `hoy`. The
 * deadline day itself is still on time. `hoy` is `diaBogota(now)`; both are
 * UTC-midnight dates, so a plain comparison is exact.
 */
export const estaVencida = (
  pqr: { estado: string; fechaLimite: Date | null },
  hoy: Date,
): boolean =>
  !!pqr.fechaLimite &&
  estadoActual(pqr.estado) !== 'cerrada' &&
  pqr.fechaLimite.getTime() < hoy.getTime();

/** Builds a log entry stamped now; `detalle` is a Spanish sentence ready to show. */
export const evento = (
  tipo: TipoEventoPqr,
  detalle: string,
  actor: { nombre: string; accountId?: string | null },
): EventoPqr => ({
  fecha: new Date(),
  tipo,
  actor: actor.nombre,
  accountId: actor.accountId ? new Types.ObjectId(actor.accountId) : null,
  detalle,
});
