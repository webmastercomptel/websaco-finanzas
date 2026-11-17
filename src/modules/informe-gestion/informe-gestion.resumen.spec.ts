import {
  rangoDelPeriodo,
  resumirActividades,
  resumirMantenimientos,
  resumirPqr,
  validarPeriodo,
  type FilaMantenimiento,
} from './informe-gestion.resumen';

const mant = (p: Partial<FilaMantenimiento>): FilaMantenimiento => ({
  fecha: new Date('2026-11-05T00:00:00.000Z'),
  titulo: 'T',
  tipo: 'preventivo',
  equipo: null,
  responsable: null,
  estado: 'completado',
  costoEstimado: null,
  equipoId: null,
  ...p,
});

describe('rangoDelPeriodo', () => {
  it('convierte el período a rangos UTC y de Bogotá (medianoche +5h)', () => {
    const r = rangoDelPeriodo('2026-11-01', '2026-11-30');
    expect(r.inicioUtc.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(r.finUtcExclusivo.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(r.inicioBogota.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(r.finBogotaExclusivo.toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });
});

describe('validarPeriodo', () => {
  it('rechaza Desde posterior a Hasta', () => {
    expect(validarPeriodo('2026-11-30', '2026-11-01')).toBe(
      'La fecha Desde no puede ser posterior a Hasta.',
    );
  });
  it('acepta 366 días contando ambos extremos', () => {
    expect(validarPeriodo('2025-01-01', '2026-01-01')).toBeNull();
  });
  it('rechaza 367 días', () => {
    expect(validarPeriodo('2025-01-01', '2026-01-02')).toBe(
      'El período no puede superar un año.',
    );
  });
  it('acepta un solo día', () => {
    expect(validarPeriodo('2026-11-01', '2026-11-01')).toBeNull();
  });
});

describe('resumirActividades', () => {
  it('lista vacía devuelve ceros', () => {
    expect(resumirActividades([])).toEqual({
      total: 0,
      porEstado: {},
      inscritos: 0,
    });
  });
  it('cuenta por estado y suma inscritos', () => {
    const f = (estado: string, inscritos: number) => ({
      fecha: new Date(),
      titulo: 'A',
      categoria: 'salud',
      estado,
      inscritos,
    });
    expect(
      resumirActividades([f('proximo', 3), f('proximo', 2), f('cancelado', 1)]),
    ).toEqual({
      total: 3,
      porEstado: { proximo: 2, cancelado: 1 },
      inscritos: 6,
    });
  });
});

describe('resumirMantenimientos', () => {
  it('lista vacía devuelve ceros', () => {
    expect(resumirMantenimientos([])).toEqual({
      total: 0,
      porTipo: {},
      porEstado: {},
      costoEstimadoTotal: 0,
      equiposAtendidos: 0,
    });
  });
  it('ignora costos nulos', () => {
    const r = resumirMantenimientos([
      mant({ costoEstimado: null }),
      mant({ costoEstimado: 150000 }),
    ]);
    expect(r.costoEstimadoTotal).toBe(150000);
  });
  it('cuenta equipos distintos excluyendo cancelados', () => {
    const r = resumirMantenimientos([
      mant({ equipoId: 'e1' }),
      mant({ equipoId: 'e1', tipo: 'correctivo' }),
      mant({ equipoId: 'e2', estado: 'cancelado' }),
      mant({ equipoId: null }),
    ]);
    expect(r.equiposAtendidos).toBe(1);
    expect(r.porTipo).toEqual({ preventivo: 3, correctivo: 1 });
  });
});

describe('resumirPqr', () => {
  it('lista vacía devuelve ceros', () => {
    expect(resumirPqr([])).toEqual({
      total: 0,
      porTipo: {},
      porEstado: {},
      abiertas: 0,
    });
  });
  it('cuenta abiertas (no resueltas ni cerradas)', () => {
    const f = (estado: string, tipo = 'quejas') => ({
      fecha: new Date(),
      codigo: 'X',
      unidad: '101',
      tipo,
      prioridad: 'alta',
      estado,
    });
    const r = resumirPqr([
      f('pendiente'),
      f('urgente', 'reclamos'),
      f('resuelto'),
      f('cerrado'),
    ]);
    expect(r.total).toBe(4);
    expect(r.abiertas).toBe(2);
    expect(r.porTipo).toEqual({ quejas: 3, reclamos: 1 });
  });
});
