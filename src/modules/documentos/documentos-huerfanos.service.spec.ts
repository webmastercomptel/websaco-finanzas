import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { Types } from 'mongoose';
import { ejecutarAlArrancar } from '../../common/programacion/tarea-programada';
import { DocumentosAlmacenService } from './documentos-almacen.service';
import {
  DocumentosHuerfanosService,
  GRACIA_SUBIDAS_PENDIENTES_MS,
} from './documentos-huerfanos.service';

// Only the startup helper is replaced: the real `ejecutarTareaProgramada` must
// keep running so the tests exercise the lock and the never-throw wrapper.
jest.mock('../../common/programacion/tarea-programada', () => ({
  ...jest.requireActual<
    typeof import('../../common/programacion/tarea-programada')
  >('../../common/programacion/tarea-programada'),
  ejecutarAlArrancar: jest.fn(),
}));

interface Registro {
  _id: Types.ObjectId;
  estado: 'pendiente' | 'listo';
  createdAt: Date;
  rutaAlmacenamiento: string | null;
}

interface FiltroCron {
  _id?: Types.ObjectId;
  estado: string;
  createdAt: { $lt: Date };
}

const HACE = (ms: number) => new Date(Date.now() - ms);
const HORA = 60 * 60 * 1000;

const registro = (extra: Partial<Registro> = {}): Registro => ({
  _id: new Types.ObjectId(),
  estado: 'pendiente',
  createdAt: HACE(2 * HORA),
  rutaAlmacenamiento: `documentos-administracion/cop/${new Types.ObjectId().toString()}-a.pdf`,
  ...extra,
});

/** A tiny in-memory collection that applies the cron's filters for real. */
function montar(registros: Registro[]) {
  const coincide = (r: Registro, f: FiltroCron) =>
    (f._id === undefined || r._id.equals(f._id)) &&
    r.estado === f.estado &&
    r.createdAt < f.createdAt.$lt;

  const filtrosUsados: FiltroCron[] = [];
  const archivos = {
    find: jest.fn((f: FiltroCron) => {
      filtrosUsados.push(f);
      const q: Record<string, jest.Mock> = {};
      q.select = jest.fn().mockReturnValue(q);
      q.lean = jest.fn().mockReturnValue(q);
      q.exec = jest.fn(() =>
        Promise.resolve(registros.filter((r) => coincide(r, f))),
      );
      return q;
    }),
    deleteOne: jest.fn((f: FiltroCron) => ({
      exec: jest.fn(() => {
        filtrosUsados.push(f);
        const i = registros.findIndex((r) => coincide(r, f));
        if (i === -1) return Promise.resolve({ deletedCount: 0 });
        registros.splice(i, 1);
        return Promise.resolve({ deletedCount: 1 });
      }),
    })),
  };

  const borrados: string[] = [];
  const tocados: string[] = [];
  const bucket = {
    file: jest.fn((ruta: string) => {
      tocados.push(ruta);
      return {
        delete: jest.fn(() => {
          borrados.push(ruta);
          return Promise.resolve();
        }),
      };
    }),
    getFiles: jest.fn(),
    getSignedUrl: jest.fn(),
  };
  const almacen = new DocumentosAlmacenService(bucket as never);
  const lock = {
    runExclusive: jest
      .fn<Promise<boolean>, [string, number, () => Promise<void>]>()
      .mockImplementation(async (_clave, _ttl, tarea) => {
        await tarea();
        return true;
      }),
  };
  const servicio = new DocumentosHuerfanosService(
    archivos as never,
    almacen,
    lock as never,
  );
  return {
    servicio,
    archivos,
    bucket,
    borrados,
    tocados,
    lock,
    registros,
    filtrosUsados,
  };
}

describe('DocumentosHuerfanosService — cron', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    (ejecutarAlArrancar as jest.Mock).mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it('se programa a las 3 AM diarias', () => {
    const prototipo = DocumentosHuerfanosService.prototype as unknown as Record<
      string,
      object
    >;
    const cron = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      prototipo.limpiarPendientes,
    ) as { cronTime: string };
    expect(cron.cronTime).toBe(CronExpression.EVERY_DAY_AT_3AM);
  });

  it('corre bajo el lock con la clave y el TTL previstos', async () => {
    const { servicio, lock } = montar([]);
    await servicio.limpiarPendientes();
    expect(lock.runExclusive).toHaveBeenCalledWith(
      'cron:documentos:huerfanos',
      1_800_000,
      expect.any(Function),
    );
  });

  it('elimina el registro y el objeto de una subida pendiente de más de una hora', async () => {
    const vieja = registro({ createdAt: HACE(2 * HORA) });
    const { servicio, registros, borrados } = montar([vieja]);

    await servicio.limpiarPendientes();

    expect(registros).toHaveLength(0);
    expect(borrados).toEqual([vieja.rutaAlmacenamiento]);
  });

  it('no toca una subida pendiente dentro del período de gracia', async () => {
    const reciente = registro({
      createdAt: HACE(GRACIA_SUBIDAS_PENDIENTES_MS - 60_000),
    });
    const { servicio, registros, tocados } = montar([reciente]);

    await servicio.limpiarPendientes();

    expect(registros).toEqual([reciente]);
    expect(tocados).toEqual([]);
  });

  it('nunca borra un documento listo, por viejo que sea, ni su objeto', async () => {
    const listo = registro({
      estado: 'listo',
      createdAt: HACE(400 * 24 * HORA),
    });
    const { servicio, registros, tocados } = montar([listo]);

    await servicio.limpiarPendientes();

    expect(registros).toEqual([listo]);
    expect(tocados).toEqual([]);
  });

  it('en una mezcla borra únicamente los pendientes vencidos', async () => {
    const vencido = registro();
    const reciente = registro({ createdAt: HACE(10 * 60_000) });
    const listo = registro({ estado: 'listo' });
    const { servicio, registros, borrados } = montar([
      vencido,
      reciente,
      listo,
    ]);

    await servicio.limpiarPendientes();

    expect(registros).toEqual([reciente, listo]);
    expect(borrados).toEqual([vencido.rutaAlmacenamiento]);
  });

  it('jamás lista el bucket: solo mira registros', async () => {
    const { servicio, bucket } = montar([registro(), registro()]);
    await servicio.limpiarPendientes();
    expect(bucket.getFiles).not.toHaveBeenCalled();
  });

  it('solo borra objetos bajo documentos-administracion/, aunque un registro apunte a otro prefijo', async () => {
    const malos = [
      registro({ rutaAlmacenamiento: 'facturas/2026/f-001.pdf' }),
      registro({ rutaAlmacenamiento: 'pqrs/cop/1/evidencia.png' }),
      registro({ rutaAlmacenamiento: 'zonas/cop/1/portada.png' }),
      registro({ rutaAlmacenamiento: 'documentos/cop/recibo.pdf' }),
      registro({ rutaAlmacenamiento: 'documentos-administracion/' }),
    ];
    const bueno = registro();
    const { servicio, borrados, tocados, registros } = montar([
      ...malos,
      bueno,
    ]);

    await servicio.limpiarPendientes();

    // Every object path that reached the bucket is inside the prefix...
    expect(
      tocados.every((r) => r.startsWith('documentos-administracion/')),
    ).toBe(true);
    // ...and the only deletion is the legitimate one.
    expect(borrados).toEqual([bueno.rutaAlmacenamiento]);
    // The corrupted records are still swept, but their foreign objects are not touched.
    expect(registros).toHaveLength(0);
    expect(errorLog).toHaveBeenCalled();
  });

  it('un registro sin ruta se elimina sin tocar el bucket', async () => {
    const sinRuta = registro({ rutaAlmacenamiento: null });
    const { servicio, registros, bucket } = montar([sinRuta]);

    await servicio.limpiarPendientes();

    expect(registros).toHaveLength(0);
    expect(bucket.file).not.toHaveBeenCalled();
  });

  it('si el documento se confirma entre la lectura y el borrado, no se borra su objeto', async () => {
    const carrera = registro();
    const { servicio, archivos, registros, tocados } = montar([carrera]);
    // The browser confirms right after the cron read the row.
    archivos.deleteOne.mockImplementationOnce(() => ({
      exec: jest.fn(() => {
        carrera.estado = 'listo';
        return Promise.resolve({ deletedCount: 0 });
      }),
    }));

    await servicio.limpiarPendientes();

    expect(registros).toEqual([carrera]);
    expect(tocados).toEqual([]);
  });

  it('cada borrado re-verifica estado pendiente y antigüedad, no solo el id', async () => {
    const { servicio, filtrosUsados } = montar([registro()]);

    await servicio.limpiarPendientes();

    const deBorrado = filtrosUsados.filter((f) => f._id !== undefined);
    expect(deBorrado).toHaveLength(1);
    expect(deBorrado[0].estado).toBe('pendiente');
    expect(deBorrado[0].createdAt.$lt).toBeInstanceOf(Date);
  });

  it('el corte es de una hora hacia atrás', async () => {
    const antes = Date.now();
    const { servicio, filtrosUsados } = montar([]);

    await servicio.limpiarPendientes();

    const limite = filtrosUsados[0].createdAt.$lt.getTime();
    expect(Math.abs(antes - HORA - limite)).toBeLessThan(5000);
  });

  it('el fallo con un registro no impide limpiar los demás', async () => {
    const a = registro();
    const b = registro();
    const { servicio, archivos, borrados } = montar([a, b]);
    archivos.deleteOne.mockImplementationOnce(() => ({
      exec: jest.fn(() => Promise.reject(new Error('mongo parpadeó'))),
    }));

    await servicio.limpiarPendientes();

    expect(borrados).toEqual([b.rutaAlmacenamiento]);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(a._id.toString()),
    );
  });

  it('si otra instancia tiene el lock no hace nada', async () => {
    const { servicio, archivos, lock } = montar([registro()]);
    lock.runExclusive.mockResolvedValue(false);

    await servicio.limpiarPendientes();

    expect(archivos.find).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo de la base se registra y se traga', async () => {
    const { servicio, archivos } = montar([]);
    archivos.find.mockImplementation(() => {
      throw new Error('mongo caído');
    });

    await expect(servicio.limpiarPendientes()).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('cron:documentos:huerfanos'),
    );
  });

  it('onApplicationBootstrap delega la pasada inicial en el helper de arranque, bajo el lock', async () => {
    const { servicio, lock } = montar([]);

    servicio.onApplicationBootstrap();

    expect(ejecutarAlArrancar).toHaveBeenCalledWith(
      expect.anything(),
      'limpieza de subidas de documentos',
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
