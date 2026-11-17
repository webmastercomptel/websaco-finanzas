// src/modules/informe-gestion/informe-gestion.resumen.ts
// Pure functions (no Nest dependencies) shared by the PDF builder and the service.

const DIA_MS = 24 * 60 * 60 * 1000;
/** Bogotá is UTC-5 all year (no DST): its midnight is 05:00Z. */
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;
const MAX_DIAS_PERIODO = 366;

export interface FilaActividad {
  fecha: Date;
  titulo: string;
  categoria: string;
  estado: string;
  inscritos: number;
}

export interface FilaMantenimiento {
  fecha: Date;
  titulo: string;
  tipo: string;
  equipo: string | null;
  responsable: string | null;
  estado: string;
  costoEstimado: number | null;
  equipoId: string | null;
}

export interface FilaPqr {
  fecha: Date;
  codigo: string;
  unidad: string;
  tipo: string;
  prioridad: string;
  estado: string;
}

/**
 * Query bounds for an inclusive `desde`..`hasta` period. Business dates
 * (actividad, mantenimiento) sit at UTC midnight; PQR uses `createdAt`, a real
 * instant, so it needs the Bogotá day boundaries. Ends are exclusive.
 */
export function rangoDelPeriodo(
  desde: string,
  hasta: string,
): {
  inicioUtc: Date;
  finUtcExclusivo: Date;
  inicioBogota: Date;
  finBogotaExclusivo: Date;
} {
  const inicioUtc = new Date(`${desde}T00:00:00.000Z`);
  const finUtcExclusivo = new Date(
    new Date(`${hasta}T00:00:00.000Z`).getTime() + DIA_MS,
  );
  return {
    inicioUtc,
    finUtcExclusivo,
    inicioBogota: new Date(inicioUtc.getTime() + BOGOTA_OFFSET_MS),
    finBogotaExclusivo: new Date(finUtcExclusivo.getTime() + BOGOTA_OFFSET_MS),
  };
}

/** Cross-field period rule; returns the Spanish error text or null. */
export function validarPeriodo(desde: string, hasta: string): string | null {
  const d = new Date(`${desde}T00:00:00.000Z`).getTime();
  const h = new Date(`${hasta}T00:00:00.000Z`).getTime();
  if (d > h) return 'La fecha Desde no puede ser posterior a Hasta.';
  if (Math.round((h - d) / DIA_MS) + 1 > MAX_DIAS_PERIODO) {
    return 'El período no puede superar un año.';
  }
  return null;
}

function contar<T>(
  filas: T[],
  clave: (f: T) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of filas) {
    const k = clave(f);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function resumirActividades(filas: FilaActividad[]): {
  total: number;
  porEstado: Record<string, number>;
  inscritos: number;
} {
  return {
    total: filas.length,
    porEstado: contar(filas, (f) => f.estado),
    inscritos: filas.reduce((s, f) => s + f.inscritos, 0),
  };
}

export function resumirMantenimientos(filas: FilaMantenimiento[]): {
  total: number;
  porTipo: Record<string, number>;
  porEstado: Record<string, number>;
  costoEstimadoTotal: number;
  equiposAtendidos: number;
} {
  const equipos = new Set<string>();
  let costo = 0;
  for (const f of filas) {
    if (f.costoEstimado !== null && Number.isFinite(f.costoEstimado)) {
      costo += f.costoEstimado;
    }
    if (f.equipoId && f.estado !== 'cancelado') equipos.add(f.equipoId);
  }
  return {
    total: filas.length,
    porTipo: contar(filas, (f) => f.tipo),
    porEstado: contar(filas, (f) => f.estado),
    costoEstimadoTotal: costo,
    equiposAtendidos: equipos.size,
  };
}

export function resumirPqr(filas: FilaPqr[]): {
  total: number;
  porTipo: Record<string, number>;
  porEstado: Record<string, number>;
  abiertas: number;
} {
  return {
    total: filas.length,
    porTipo: contar(filas, (f) => f.tipo),
    porEstado: contar(filas, (f) => f.estado),
    abiertas: filas.filter(
      (f) => f.estado !== 'resuelto' && f.estado !== 'cerrado',
    ).length,
  };
}
