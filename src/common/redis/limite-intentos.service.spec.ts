import { Logger } from '@nestjs/common';
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

  it('SEC: el registro de un fallo de Redis nombra la familia de la clave, nunca la IP, el hash ni el token', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      const { servicio } = crear(() => Promise.reject(new Error('caído')));

      await servicio.permitir('limite:ingreso-solicitar:ip:203.0.113.5', 3, 1);
      await servicio.permitir(
        'limite:ingreso-canjear:token:' + 'ab'.repeat(32),
        3,
        1,
      );

      const registrado = (error.mock.calls as unknown[][])
        .map((c) => String(c[0]))
        .join(' | ');
      expect(registrado).toContain('limite:ingreso-solicitar:ip');
      expect(registrado).toContain('limite:ingreso-canjear:token');
      expect(registrado).not.toContain('203.0.113.5');
      expect(registrado).not.toContain('ab'.repeat(32));
    } finally {
      error.mockRestore();
    }
  });
});
