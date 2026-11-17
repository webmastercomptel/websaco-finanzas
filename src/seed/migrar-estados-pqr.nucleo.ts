import type { PipelineStage } from 'mongoose';
import {
  ESTADOS_PQR_LEGADOS,
  type EstadoPqr,
} from '../database/schemas/administracion/pqr.schema';

/** What the conversion does with one legacy `estado` value. */
export interface PasoMigracionPqr {
  /** The stage that replaces the legacy value. */
  estado: EstadoPqr;
  /** `urgente` was a status; it becomes `prioridad: 'alta'`. */
  prioridadAlta: boolean;
  /** The PQR was finished: stamp `cerradaEn` when it has none. */
  cerrar: boolean;
  /** How the old status read, for the log entry. */
  etiquetaAnterior: string;
}

export type EstadoLegadoPqr = (typeof ESTADOS_PQR_LEGADOS)[number];

export const PLAN_MIGRACION_PQR: Record<EstadoLegadoPqr, PasoMigracionPqr> = {
  pendiente: {
    estado: 'radicada',
    prioridadAlta: false,
    cerrar: false,
    etiquetaAnterior: 'Pendiente',
  },
  en_revision: {
    estado: 'en_gestion',
    prioridadAlta: false,
    cerrar: false,
    etiquetaAnterior: 'En revisión',
  },
  urgente: {
    estado: 'en_gestion',
    prioridadAlta: true,
    cerrar: false,
    etiquetaAnterior: 'Urgente',
  },
  resuelto: {
    estado: 'cerrada',
    prioridadAlta: false,
    cerrar: true,
    etiquetaAnterior: 'Resuelto',
  },
  cerrado: {
    estado: 'cerrada',
    prioridadAlta: false,
    cerrar: true,
    etiquetaAnterior: 'Cerrado',
  },
};

export interface ModoMigracionPqr {
  /** Without it nothing is written. */
  aplicar: boolean;
}

/**
 * Reads the script's flags. `--env=<name>` is consumed by `load-script-env`;
 * any other `--flag` stops the script before it opens a connection.
 */
export function leerModo(argv: readonly string[]): ModoMigracionPqr {
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    if (arg.startsWith('--env=') || arg === '--aplicar') continue;
    throw new Error(`Opción desconocida: ${arg}`);
  }
  return { aplicar: argv.includes('--aplicar') };
}

/**
 * The update pipeline for every PQR stored with `legado`. The log entry is
 * appended in the same write, so a converted row always says what it was.
 */
export function actualizacionPara(legado: EstadoLegadoPqr): PipelineStage[] {
  const paso = PLAN_MIGRACION_PQR[legado];
  const campos: Record<string, unknown> = { estado: paso.estado };
  if (paso.prioridadAlta) campos.prioridad = 'alta';
  if (paso.cerrar) campos.cerradaEn = { $ifNull: ['$cerradaEn', '$updatedAt'] };
  campos.bitacora = {
    $concatArrays: [
      { $ifNull: ['$bitacora', []] },
      [
        {
          fecha: '$$NOW',
          tipo: 'migrada',
          actor: 'Sistema',
          accountId: null,
          detalle: `Estado anterior: «${paso.etiquetaAnterior}»`,
        },
      ],
    ],
  };
  return [{ $set: campos }];
}

/** The Spanish summary the script prints. `conteos` is keyed by legacy value. */
export function informe(
  conteos: Record<string, number>,
  aplicado: boolean,
): string {
  const lineas = ESTADOS_PQR_LEGADOS.map((legado) => {
    const paso = PLAN_MIGRACION_PQR[legado];
    return `  ${legado} → ${paso.estado}${paso.prioridadAlta ? ' (prioridad alta)' : ''}: ${conteos[legado] ?? 0}`;
  });
  const total = ESTADOS_PQR_LEGADOS.reduce(
    (suma, legado) => suma + (conteos[legado] ?? 0),
    0,
  );
  const cierre = aplicado
    ? `Convertidas: ${total} PQRS.`
    : total > 0
      ? `Pendientes de convertir: ${total} PQRS. Nada se escribió; ejecuta con --aplicar.`
      : 'No hay PQRS con estados anteriores.';
  return [
    aplicado ? 'PQRS convertidas a etapas:' : 'PQRS con estados anteriores:',
    ...lineas,
    cierre,
  ].join('\n');
}
