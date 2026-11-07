import { Logger } from '@nestjs/common';
import { ejecutarAlArrancar } from '../../common/programacion/tarea-programada';
import {
  DIAS_PARA_CERRAR,
  PqrCierreAutomaticoService,
} from './pqr-cierre-automatico.service';

// Only the startup helper is replaced: the real `ejecutarTareaProgramada` must
// keep running so the tests exercise the lock and the never-throw wrapper.
jest.mock('../../common/programacion/tarea-programada', () => ({
  ...jest.requireActual<
    typeof import('../../common/programacion/tarea-programada')
  >('../../common/programacion/tarea-programada'),
  ejecutarAlArrancar: jest.fn(),
}));

function montar() {
  const pqrs = {
    updateMany: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 4 }),
    }),
  };
  const lock = {
    runExclusive: jest
      .fn<Promise<boolean>, [string, number, () => Promise<void>]>()
      .mockImplementation(async (_clave, _ttl, tarea) => {
        await tarea();
        return true;
      }),
  };
  const servicio = new PqrCierreAutomaticoService(pqrs as never, lock as never);
  return { servicio, pqrs, lock };
}

describe('PqrCierreAutomaticoService.cerrarResueltas — cron', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('corre bajo el lock con la clave y el TTL previstos', async () => {
    const { servicio, lock } = montar();

    await servicio.cerrarResueltas();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'cron:pqr:cierre-automatico',
      600_000,
      expect.any(Function),
    );
  });

  it('cierra solo las resueltas sin actividad hace más de 5 días, en todas las copropiedades', async () => {
    const { servicio, pqrs } = montar();
    const antes = Date.now();

    await servicio.cerrarResueltas();

    expect(DIAS_PARA_CERRAR).toBe(5);
    const [filtro, cambio] = pqrs.updateMany.mock.calls[0] as [
      { estado: string; updatedAt: { $lt: Date }; copropiedadId?: unknown },
      unknown,
    ];
    expect(filtro.estado).toBe('resuelto');
    expect(filtro).not.toHaveProperty('copropiedadId');
    expect(cambio).toEqual({ $set: { estado: 'cerrado' } });
    const limite = filtro.updatedAt.$lt.getTime();
    const cincoDias = 5 * 24 * 60 * 60 * 1000;
    // setDate keeps wall-clock time across DST changes, so allow an hour.
    expect(Math.abs(antes - cincoDias - limite)).toBeLessThan(
      60 * 60 * 1000 + 5000,
    );
  });

  it('si otra instancia tiene el lock no ejecuta el cambio', async () => {
    const { servicio, pqrs, lock } = montar();
    lock.runExclusive.mockResolvedValue(false);

    await servicio.cerrarResueltas();

    expect(pqrs.updateMany).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo de la base se registra y se traga', async () => {
    const { servicio, pqrs } = montar();
    pqrs.updateMany.mockReturnValue({
      exec: jest.fn().mockRejectedValue(new Error('mongo caído')),
    });

    await expect(servicio.cerrarResueltas()).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('cron:pqr:cierre-automatico'),
    );
  });

  it('nunca lanza si falla el propio lock', async () => {
    const { servicio, lock } = montar();
    lock.runExclusive.mockRejectedValue(new Error('redis caído'));

    await expect(servicio.cerrarResueltas()).resolves.toBeUndefined();
  });

  it('onApplicationBootstrap delega la pasada inicial en el helper de arranque', async () => {
    const { servicio, lock } = montar();

    servicio.onApplicationBootstrap();

    expect(ejecutarAlArrancar).toHaveBeenCalledWith(
      expect.anything(),
      'cierre automático de PQR',
      expect.any(Function),
    );
    const [, , tarea] = (
      ejecutarAlArrancar as jest.Mock<
        void,
        [unknown, string, () => Promise<void>]
      >
    ).mock.calls[0];
    await tarea();
    expect(lock.runExclusive).toHaveBeenCalledTimes(1);
  });
});
