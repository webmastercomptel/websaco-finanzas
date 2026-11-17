import {
  VALORES_ABIERTOS,
  VALORES_CERRADOS,
  estadoActual,
  estaVencida,
  evento,
  valoresDeEstado,
} from './pqr-etapas';

describe('estadoActual', () => {
  it.each([
    ['radicada', 'radicada'],
    ['clasificada', 'clasificada'],
    ['en_gestion', 'en_gestion'],
    ['cerrada', 'cerrada'],
    ['pendiente', 'radicada'],
    ['en_revision', 'en_gestion'],
    ['urgente', 'en_gestion'],
    ['resuelto', 'cerrada'],
    ['cerrado', 'cerrada'],
    ['desconocido', 'radicada'],
  ])('%s -> %s', (valor, esperado) => {
    expect(estadoActual(valor)).toBe(esperado);
  });
});

describe('valoresDeEstado', () => {
  it('lista los valores guardados de cada etapa', () => {
    expect(valoresDeEstado('en_gestion')).toEqual([
      'en_gestion',
      'en_revision',
      'urgente',
    ]);
    expect(valoresDeEstado('cerrada')).toEqual([
      'cerrada',
      'resuelto',
      'cerrado',
    ]);
  });

  it('abiertos y cerrados no se solapan y cubren todo', () => {
    expect(VALORES_CERRADOS).toEqual(['cerrada', 'resuelto', 'cerrado']);
    expect(VALORES_ABIERTOS).not.toContain('resuelto');
    expect(VALORES_ABIERTOS).toEqual(
      expect.arrayContaining(['radicada', 'pendiente', 'urgente']),
    );
    expect(VALORES_ABIERTOS.length + VALORES_CERRADOS.length).toBe(9);
  });
});

describe('estaVencida', () => {
  const limite = new Date('2026-12-09T00:00:00Z');

  it('no vence sin fecha límite', () => {
    expect(
      estaVencida(
        { estado: 'radicada', fechaLimite: null },
        new Date('2027-01-01T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('no vence si está cerrada', () => {
    expect(
      estaVencida(
        { estado: 'cerrada', fechaLimite: limite },
        new Date('2027-01-01T00:00:00Z'),
      ),
    ).toBe(false);
    expect(
      estaVencida(
        { estado: 'resuelto', fechaLimite: limite },
        new Date('2027-01-01T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('el mismo día límite aún no vence; al día siguiente sí', () => {
    const pqr = { estado: 'en_gestion', fechaLimite: limite };
    expect(estaVencida(pqr, new Date('2026-12-09T00:00:00Z'))).toBe(false);
    expect(estaVencida(pqr, new Date('2026-12-10T00:00:00Z'))).toBe(true);
  });
});

describe('evento', () => {
  it('arma la entrada con la fecha de ahora y el actor congelado', () => {
    const e = evento('cerrada', 'Cerrada por Ana', { nombre: 'Ana' });
    expect(e).toMatchObject({
      tipo: 'cerrada',
      actor: 'Ana',
      accountId: null,
      detalle: 'Cerrada por Ana',
    });
    expect(e.fecha).toBeInstanceOf(Date);
  });
});
