import { esperarPisoDeTiempo } from './piso-de-tiempo';

describe('esperarPisoDeTiempo', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('espera lo que falta hasta el piso', async () => {
    const inicio = Date.now();
    let resuelto = false;
    const espera = esperarPisoDeTiempo(inicio, 300).then(() => {
      resuelto = true;
    });

    await jest.advanceTimersByTimeAsync(299);
    expect(resuelto).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await espera;
    expect(resuelto).toBe(true);
  });

  it('vuelve de inmediato si el piso ya pasó', async () => {
    const inicio = Date.now();
    jest.setSystemTime(inicio + 500);

    await expect(esperarPisoDeTiempo(inicio, 300)).resolves.toBeUndefined();
  });
});
