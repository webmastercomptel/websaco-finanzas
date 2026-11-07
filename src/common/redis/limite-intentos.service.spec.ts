import { LimiteIntentosService } from './limite-intentos.service';

function crear(evalImpl: () => Promise<unknown>) {
  const redis = { eval: jest.fn().mockImplementation(evalImpl) };
  return { redis, servicio: new LimiteIntentosService(redis as never) };
}

describe('LimiteIntentosService', () => {
  it('permite mientras el contador no supera el límite y fija la ventana', async () => {
    const { servicio, redis } = crear(() => Promise.resolve(3));

    await expect(servicio.permitir('k', 3, 60_000)).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('pexpire'),
      1,
      'k',
      '60000',
    );
  });

  it('rechaza el intento que supera el límite', async () => {
    const { servicio } = crear(() => Promise.resolve(4));

    await expect(servicio.permitir('k', 3, 60_000)).resolves.toBe(false);
  });

  it('falla cerrado: si Redis no responde, rechaza', async () => {
    const { servicio } = crear(() => Promise.reject(new Error('caído')));

    await expect(servicio.permitir('k', 3, 60_000)).resolves.toBe(false);
  });
});
