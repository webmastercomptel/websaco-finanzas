import {
  DESFASE_BOGOTA_MS,
  inicioDelDiaBogota,
  relojDeParedBogota,
} from './reloj-bogota';

describe('relojDeParedBogota', () => {
  afterEach(() => jest.restoreAllMocks());

  it('escribe la hora de Bogotá como si fuera UTC: 16:30 en Bogotá es 16:30Z', () => {
    // 21:30 UTC real = 16:30 in Bogotá (UTC-5, no daylight saving).
    const ahora = Date.parse('2026-09-10T21:30:00.000Z');

    expect(relojDeParedBogota(ahora).toISOString()).toBe(
      '2026-09-10T16:30:00.000Z',
    );
  });

  it('sin argumento lee el reloj real (Date.now), así las pruebas lo fijan', () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-01-01T03:00:00.000Z'));

    expect(relojDeParedBogota().toISOString()).toBe('2025-12-31T22:00:00.000Z');
  });

  it('el desfase es una constante de 5 horas: Colombia no tiene horario de verano', () => {
    expect(DESFASE_BOGOTA_MS).toBe(5 * 60 * 60 * 1000);
    // Same offset in January and in July.
    expect(
      relojDeParedBogota(Date.parse('2026-07-01T12:00:00.000Z')).toISOString(),
    ).toBe('2026-07-01T07:00:00.000Z');
  });
});

describe('inicioDelDiaBogota', () => {
  it('a las 22:00 de Bogotá (03:00 UTC del día siguiente) el día sigue siendo el de Bogotá', () => {
    const ahora = Date.parse('2026-09-10T03:00:00.000Z');

    expect(inicioDelDiaBogota(ahora).toISOString()).toBe(
      '2026-09-09T00:00:00.000Z',
    );
  });

  it('a las 00:30 de Bogotá ya es el día nuevo', () => {
    const ahora = Date.parse('2026-09-10T05:30:00.000Z');

    expect(inicioDelDiaBogota(ahora).toISOString()).toBe(
      '2026-09-10T00:00:00.000Z',
    );
  });
});
