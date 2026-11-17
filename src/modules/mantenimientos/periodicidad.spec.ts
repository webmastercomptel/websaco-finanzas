import { siguienteFecha } from './periodicidad';

const f = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('siguienteFecha', () => {
  it.each([
    ['2026-01-12', 'semanal', '2026-01-19'],
    ['2026-01-31', 'mensual', '2026-02-28'],
    ['2028-01-31', 'mensual', '2028-02-29'],
    ['2026-08-31', 'semestral', '2027-02-28'],
    ['2028-02-29', 'anual', '2029-02-28'],
    ['2026-10-12', 'mensual', '2026-11-12'],
  ] as const)('%s %s da %s', (desde, periodicidad, esperado) => {
    expect(siguienteFecha(f(desde), periodicidad)).toEqual(f(esperado));
  });

  it('conserva la hora UTC y no muta la fecha de entrada', () => {
    const entrada = new Date('2026-01-31T08:30:00.000Z');
    const r = siguienteFecha(entrada, 'mensual');
    expect(r.toISOString()).toBe('2026-02-28T08:30:00.000Z');
    expect(entrada.toISOString()).toBe('2026-01-31T08:30:00.000Z');
  });
});
