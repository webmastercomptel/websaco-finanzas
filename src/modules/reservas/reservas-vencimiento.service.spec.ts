import { Logger } from '@nestjs/common';
import { ejecutarAlArrancar } from '../../common/programacion/tarea-programada';
import { ReservasVencimientoService } from './reservas-vencimiento.service';

// Only the startup helper is replaced: the real `ejecutarTareaProgramada` must
// keep running so the tests exercise the lock and the never-throw wrapper.
jest.mock('../../common/programacion/tarea-programada', () => ({
  ...jest.requireActual<
    typeof import('../../common/programacion/tarea-programada')
  >('../../common/programacion/tarea-programada'),
  ejecutarAlArrancar: jest.fn(),
}));

function montar() {
  const reservas = {
    updateMany: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
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
  const servicio = new ReservasVencimientoService(
    reservas as never,
    lock as never,
  );
  return { servicio, reservas, lock };
}

describe('ReservasVencimientoService.vencerPendientes — cron', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('corre bajo el lock con la clave y el TTL previstos', async () => {
    const { servicio, lock } = montar();

    await servicio.vencerPendientes();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'cron:reservas:vencer-pendientes',
      600_000,
      expect.any(Function),
    );
  });

  it('cancela solo las pendientes cuyo inicio ya pasó, en todas las copropiedades', async () => {
    const { servicio, reservas } = montar();

    await servicio.vencerPendientes();

    const [filtro] = reservas.updateMany.mock.calls[0] as [
      { estado: string; inicio: { $lt: Date }; copropiedadId?: unknown },
    ];
    expect(filtro.estado).toBe('pendiente');
    expect(filtro).not.toHaveProperty('copropiedadId');
    expect(filtro.inicio.$lt).toBeInstanceOf(Date);
  });

  describe('compara con la hora de Bogotá (las horas se guardan como reloj de pared)', () => {
    // 16:30 in Bogotá = 21:30 UTC real.
    beforeEach(() => {
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.parse('2026-09-10T21:30:00.000Z'));
    });

    const corte = async (): Promise<Date> => {
      const { servicio, reservas } = montar();
      await servicio.vencerPendientes();
      const [filtro] = reservas.updateMany.mock.calls[0] as [
        { inicio: { $lt: Date } },
      ];
      return filtro.inicio.$lt;
    };

    it('el corte es las 16:30 escritas, no las 21:30 UTC reales', async () => {
      expect((await corte()).toISOString()).toBe('2026-09-10T16:30:00.000Z');
    });

    it('deja la pendiente cuya hora escrita (21:00) aún no llega y cancela la que ya pasó (16:00)', async () => {
      const limite = await corte();
      // The filter is `inicio < corte`: Mongo applies exactly this comparison.
      expect(new Date('2026-09-10T21:00:00.000Z') < limite).toBe(false);
      expect(new Date('2026-09-10T16:00:00.000Z') < limite).toBe(true);
    });
  });

  it('libera la franja en el mismo update: estado cancelada Y activa false', async () => {
    const { servicio, reservas } = montar();

    await servicio.vencerPendientes();

    const [, cambio] = reservas.updateMany.mock.calls[0] as [unknown, unknown];
    expect(cambio).toEqual({
      $set: { estado: 'cancelada', activa: false },
    });
  });

  it('no avisa a nadie: ni correo ni notificación (el original tampoco)', async () => {
    const { servicio } = montar();

    // The service has no mail/directory dependency at all: its constructor takes
    // only the model and the lock, so there is nothing it could notify through.
    expect(ReservasVencimientoService.length).toBe(2);
    await expect(servicio.vencerPendientes()).resolves.toBeUndefined();
  });

  it('si otra instancia tiene el lock no ejecuta el cambio', async () => {
    const { servicio, reservas, lock } = montar();
    lock.runExclusive.mockResolvedValue(false);

    await servicio.vencerPendientes();

    expect(reservas.updateMany).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo de la base se registra y se traga', async () => {
    const { servicio, reservas } = montar();
    reservas.updateMany.mockReturnValue({
      exec: jest.fn().mockRejectedValue(new Error('mongo caído')),
    });

    await expect(servicio.vencerPendientes()).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('cron:reservas:vencer-pendientes'),
    );
  });

  it('nunca lanza si falla el propio lock', async () => {
    const { servicio, lock } = montar();
    lock.runExclusive.mockRejectedValue(new Error('redis caído'));

    await expect(servicio.vencerPendientes()).resolves.toBeUndefined();
  });

  it('onApplicationBootstrap delega la pasada inicial en el helper de arranque', async () => {
    const { servicio, lock } = montar();

    servicio.onApplicationBootstrap();

    expect(ejecutarAlArrancar).toHaveBeenCalledWith(
      expect.anything(),
      'vencimiento de reservas pendientes',
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
