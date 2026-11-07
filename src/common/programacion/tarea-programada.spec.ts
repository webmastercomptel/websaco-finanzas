import type { Logger } from '@nestjs/common';
import type { LockService } from '../redis/lock.service';
import { activateScriptEnvMode } from '../scripts/script-mode';
import {
  ejecutarAlArrancar,
  ejecutarTareaProgramada,
} from './tarea-programada';

/** A lock that either grants itself (running the task) or is held elsewhere. */
function candado(corre: boolean) {
  const runExclusive = jest.fn(
    async (_clave: string, _ttl: number, tarea: () => Promise<void>) => {
      if (!corre) return false;
      await tarea();
      return true;
    },
  );
  return { lock: { runExclusive } as unknown as LockService, runExclusive };
}

function registro() {
  const error = jest.fn();
  return { logger: { error, log: jest.fn() } as unknown as Logger, error };
}

describe('ejecutarTareaProgramada', () => {
  it('corre la tarea bajo el candado con su clave y vigencia', async () => {
    const { lock, runExclusive } = candado(true);
    const tarea = jest.fn().mockResolvedValue(undefined);

    const corrio = await ejecutarTareaProgramada(
      lock,
      registro().logger,
      { clave: 'cron:pqr:cierre', ttlMs: 60_000 },
      tarea,
    );

    expect(corrio).toBe(true);
    expect(runExclusive).toHaveBeenCalledWith(
      'cron:pqr:cierre',
      60_000,
      expect.any(Function),
    );
    expect(tarea).toHaveBeenCalledTimes(1);
  });

  it('no corre la tarea si otra instancia tiene el candado', async () => {
    const tarea = jest.fn();

    const corrio = await ejecutarTareaProgramada(
      candado(false).lock,
      registro().logger,
      { clave: 'k', ttlMs: 1 },
      tarea,
    );

    expect(corrio).toBe(false);
    expect(tarea).not.toHaveBeenCalled();
  });

  it('nunca lanza: un error de la tarea se registra y devuelve false', async () => {
    const { logger, error } = registro();

    const corrio = await ejecutarTareaProgramada(
      candado(true).lock,
      logger,
      { clave: 'k', ttlMs: 1 },
      () => Promise.reject(new Error('falló')),
    );

    expect(corrio).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('falló'));
  });
});

describe('ejecutarAlArrancar', () => {
  afterEach(() => jest.useRealTimers());

  it('lanza la tarea en segundo plano sin bloquear a quien la llama', async () => {
    jest.useFakeTimers();
    const tarea = jest.fn().mockResolvedValue(undefined);

    ejecutarAlArrancar(registro().logger, 'limpieza de PQR', tarea);

    expect(tarea).not.toHaveBeenCalled();
    await jest.runAllTimersAsync();
    expect(tarea).toHaveBeenCalledTimes(1);
  });

  it('registra el error de la tarea en vez de dejarlo sin atrapar', async () => {
    jest.useFakeTimers();
    const { logger, error } = registro();

    ejecutarAlArrancar(logger, 'limpieza de PQR', () =>
      Promise.reject(new Error('sin red')),
    );
    await jest.runAllTimersAsync();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('sin red'));
  });

  it('no hace nada en un script que eligió su entorno con --env', async () => {
    jest.useFakeTimers();
    activateScriptEnvMode();
    const tarea = jest.fn().mockResolvedValue(undefined);

    ejecutarAlArrancar(registro().logger, 'limpieza de PQR', tarea);
    await jest.runAllTimersAsync();

    expect(tarea).not.toHaveBeenCalled();
  });
});
