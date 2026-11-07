import 'reflect-metadata';
import { Types } from 'mongoose';
import {
  GRACIA_ADJUNTOS_PENDIENTES_MS,
  PqrAdjuntosHuerfanosService,
} from './pqr-adjuntos-huerfanos.service';
import { VIGENCIA_URL_ADJUNTO_MS } from './pqr-adjuntos.service';

jest.mock('../../common/programacion/tarea-programada', () => ({
  ...jest.requireActual<
    typeof import('../../common/programacion/tarea-programada')
  >('../../common/programacion/tarea-programada'),
  ejecutarAlArrancar: jest.fn(),
}));

const HORA = 60 * 60 * 1000;
const hace = (ms: number) => new Date(Date.now() - ms);

function montar(
  pqrs: Array<{ _id: Types.ObjectId; archivosAdjuntos: unknown[] }>,
  opciones: { quitado?: number; lockLibre?: boolean } = {},
) {
  const updateOne = jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue({ modifiedCount: opciones.quitado ?? 1 }),
  });
  const find = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(pqrs) }),
    }),
  });
  const borrar = jest.fn().mockResolvedValue([{}]);
  const file = jest.fn(() => ({ delete: borrar }));
  const lock = {
    runExclusive: jest.fn(
      async (_k: string, _t: number, tarea: () => Promise<void>) => {
        if (opciones.lockLibre === false) return false;
        await tarea();
        return true;
      },
    ),
  };
  const servicio = new PqrAdjuntosHuerfanosService(
    { find, updateOne } as never,
    { file } as never,
    lock as never,
  );
  return { servicio, find, updateOne, file, borrar, lock };
}

const adjunto = (extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  estado: 'pendiente',
  creadoEn: hace(2 * HORA),
  rutaAlmacenamiento: 'pqrs/cop/p/a.pdf',
  ...extra,
});

describe('PqrAdjuntosHuerfanosService', () => {
  it('la gracia supera con holgura la vida de la URL de subida', () => {
    expect(GRACIA_ADJUNTOS_PENDIENTES_MS).toBeGreaterThanOrEqual(
      2 * VIGENCIA_URL_ADJUNTO_MS,
    );
  });

  it('quita los adjuntos pendientes vencidos (re-chequeando pendiente) y luego borra su objeto', async () => {
    const pqr = new Types.ObjectId();
    const viejo = adjunto();
    const { servicio, find, updateOne, file, borrar } = montar([
      { _id: pqr, archivosAdjuntos: [viejo] },
    ]);

    await servicio.limpiarPendientes();

    const [filtro] = find.mock.calls[0] as [Record<string, unknown>];
    expect(filtro).toEqual({
      archivosAdjuntos: {
        $elemMatch: {
          estado: 'pendiente',
          creadoEn: { $lt: expect.any(Date) as Date },
        },
      },
    });
    expect(updateOne).toHaveBeenCalledWith(
      { _id: pqr },
      {
        $pull: {
          archivosAdjuntos: {
            _id: viejo._id,
            estado: 'pendiente',
            creadoEn: { $lt: expect.any(Date) as Date },
          },
        },
      },
    );
    expect(file).toHaveBeenCalledWith('pqrs/cop/p/a.pdf');
    expect(borrar).toHaveBeenCalled();
  });

  it('no toca adjuntos listos ni pendientes recientes del mismo documento', async () => {
    const { servicio, updateOne } = montar([
      {
        _id: new Types.ObjectId(),
        archivosAdjuntos: [
          adjunto({ estado: 'listo' }),
          adjunto({ creadoEn: hace(60 * 1000) }),
          adjunto({ creadoEn: null }),
        ],
      },
    ]);

    await servicio.limpiarPendientes();

    expect(updateOne).not.toHaveBeenCalled();
  });

  it('si el adjunto se confirmó mientras tanto, no borra su objeto', async () => {
    const { servicio, borrar } = montar(
      [{ _id: new Types.ObjectId(), archivosAdjuntos: [adjunto()] }],
      { quitado: 0 },
    );

    await servicio.limpiarPendientes();

    expect(borrar).not.toHaveBeenCalled();
  });

  it('nunca borra un objeto fuera de pqrs/', async () => {
    const { servicio, borrar, file } = montar([
      {
        _id: new Types.ObjectId(),
        archivosAdjuntos: [adjunto({ rutaAlmacenamiento: 'facturas/x.pdf' })],
      },
    ]);

    await servicio.limpiarPendientes();

    expect(file).not.toHaveBeenCalled();
    expect(borrar).not.toHaveBeenCalled();
  });

  it('corre bajo candado: si otra instancia lo tiene, no hace nada', async () => {
    const { servicio, find, lock } = montar([], { lockLibre: false });

    await servicio.limpiarPendientes();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'cron:pqr:adjuntos-huerfanos',
      expect.any(Number),
      expect.any(Function),
    );
    expect(find).not.toHaveBeenCalled();
  });
});
