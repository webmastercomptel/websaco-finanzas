import type Redis from 'ioredis';
import { CommonModule } from './common.module';

/**
 * Returns the client and its mocks separately: reading `redis.quit` back off
 * the object to assert on it is an unbound method reference, which the lint
 * rules reject for good reason.
 */
const redisFalso = (quitFalla = false) => {
  const quit = quitFalla
    ? jest.fn().mockRejectedValue(new Error('connection closed'))
    : jest.fn().mockResolvedValue('OK');
  const disconnect = jest.fn();
  return {
    redis: { quit, disconnect } as unknown as Redis,
    quit,
    disconnect,
  };
};

describe('CommonModule.onApplicationShutdown', () => {
  it('cierra la conexión de Redis de forma ordenada', async () => {
    // Sin esto el socket queda abierto, el event loop nunca se vacía y el
    // proceso no termina — un script que hizo su trabajo parece haber fallado.
    const { redis, quit, disconnect } = redisFalso();

    await new CommonModule(redis).onApplicationShutdown();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('corta la conexión si el cierre ordenado falla', async () => {
    // Con el enlace ya roto, quit() esperaría una respuesta que no puede
    // llegar. El apagado no puede quedar bloqueado por una conexión muerta.
    const { redis, disconnect } = redisFalso(true);

    await new CommonModule(redis).onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('no propaga el error de un cierre fallido', async () => {
    // Reventar acá dejaría el apagado a medias y podría tapar la causa real
    // por la que el proceso se estaba deteniendo.
    const { redis } = redisFalso(true);

    await expect(
      new CommonModule(redis).onApplicationShutdown(),
    ).resolves.toBeUndefined();
  });
});
