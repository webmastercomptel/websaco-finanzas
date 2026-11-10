import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { Destinatario } from '../../common/directorio/directorio.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { ejecutarAlArrancar } from '../../common/programacion/tarea-programada';
import { ActividadesService, ENVIOS_SIMULTANEOS } from './actividades.service';

// Only the startup helper is replaced: the real `ejecutarTareaProgramada` must
// keep running so the cron tests exercise the lock and the never-throw wrapper.
jest.mock('../../common/programacion/tarea-programada', () => ({
  ...jest.requireActual<
    typeof import('../../common/programacion/tarea-programada')
  >('../../common/programacion/tarea-programada'),
  ejecutarAlArrancar: jest.fn(),
}));

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
  sort: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.sort = jest.fn().mockReturnValue(q);
  return q;
};

type ModeloActividades = jest.Mock & {
  find: jest.Mock;
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
  findOneAndDelete: jest.Mock;
  updateMany: jest.Mock;
};

const COPROPIEDAD = new Types.ObjectId();
const ACTIVIDAD = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const OTRA_CUENTA = new Types.ObjectId();

const dtoBase = {
  titulo: 'Clase de yoga',
  categoria: 'salud' as const,
  fecha: '2026-09-10T08:00:00.000Z',
  horario: '08:00 - 09:00',
  ubicacion: 'Salón comunal',
};

const actividadDoc = (extra: Record<string, unknown> = {}) => ({
  _id: ACTIVIDAD,
  copropiedadId: COPROPIEDAD,
  codigo: 'ACT-001',
  titulo: 'Clase de yoga',
  descripcion: '',
  categoria: 'salud',
  fecha: new Date('2026-09-10T08:00:00.000Z'),
  horario: '08:00 - 09:00',
  ubicacion: 'Salón comunal',
  imagenUrl: null,
  destacado: false,
  tags: [],
  participantesIds: [] as Types.ObjectId[],
  capacidad: 10,
  estado: 'proximo',
  organizador: '',
  ...extra,
});

const usuario = (accountId?: Types.ObjectId): IRequestUser => ({
  uid: 'uid',
  email: 'x@y.co',
  nombre: 'Ana',
  accountId: accountId?.toString(),
});

const residente = (n: number): Destinatario => ({
  accountId: new Types.ObjectId().toString(),
  email: `residente${n}@example.com`,
  nombre: `Residente ${n}`,
  perfil: 'residente',
});

function montar() {
  const actividades = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) => {
      const instancia: Record<string, unknown> = {
        ...doc,
        _id: ACTIVIDAD,
        participantesIds: [],
      };
      instancia.save = jest.fn().mockResolvedValue(instancia);
      return instancia;
    }) as ModeloActividades;
  actividades.find = jest.fn().mockReturnValue(consulta([]));
  actividades.findOne = jest.fn().mockReturnValue(consulta(actividadDoc()));
  actividades.findOneAndUpdate = jest
    .fn()
    .mockReturnValue(consulta(actividadDoc()));
  actividades.findOneAndDelete = jest
    .fn()
    .mockReturnValue(consulta(actividadDoc()));
  actividades.updateMany = jest
    .fn()
    .mockReturnValue(consulta({ modifiedCount: 3 }));

  const consecutivos = {
    findOneAndUpdate: jest.fn().mockReturnValue(consulta({ valor: 1 })),
  };
  const copropiedades = {
    findById: jest
      .fn()
      .mockReturnValue(consulta({ nombre: 'Torres del Parque' })),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const lock = {
    runExclusive: jest
      .fn<Promise<boolean>, [string, number, () => Promise<void>]>()
      .mockImplementation(async (_clave, _ttl, tarea) => {
        await tarea();
        return true;
      }),
  };
  const residentes = [residente(1), residente(2)];
  const directorio = {
    residentes: jest
      .fn<Promise<Destinatario[]>, [Types.ObjectId]>()
      .mockResolvedValue(residentes),
  };
  const correo = {
    enviar: jest
      .fn<Promise<boolean>, [{ para: string; asunto: string; html: string }]>()
      .mockResolvedValue(true),
  };
  const enlaces = {
    construir: jest.fn().mockResolvedValue('https://app.test/auth/enlace?t=1'),
  };
  const notificaciones = { crear: jest.fn().mockResolvedValue(undefined) };

  const servicio = new ActividadesService(
    actividades as never,
    consecutivos as never,
    copropiedades as never,
    tenant as never,
    lock as never,
    directorio as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
  );
  return {
    servicio,
    actividades,
    consecutivos,
    copropiedades,
    lock,
    directorio,
    residentes,
    correo,
    enlaces,
    notificaciones,
  };
}

describe('ActividadesService.crear — aviso a los residentes', () => {
  it('crea la actividad con código ACT-001 y la copropiedad del contexto', async () => {
    const { servicio, actividades } = montar();

    const creada = await servicio.crear(dtoBase);

    expect(actividades).toHaveBeenCalledWith(
      expect.objectContaining({
        copropiedadId: COPROPIEDAD,
        codigo: 'ACT-001',
        estado: 'proximo',
        capacidad: 0,
      }),
    );
    expect(creada.codigo).toBe('ACT-001');
    expect(creada.asistentes).toBe(0);
  });

  it('avisa por correo y en la app a cada residente de la copropiedad', async () => {
    const { servicio, directorio, residentes, correo, notificaciones } =
      montar();

    await servicio.crear(dtoBase);

    expect(directorio.residentes).toHaveBeenCalledWith(COPROPIEDAD);
    expect(correo.enviar).toHaveBeenCalledTimes(2);
    expect(correo.enviar).toHaveBeenCalledWith({
      para: residentes[0].email,
      asunto: 'Nueva actividad en Torres del Parque: Clase de yoga',
      html: expect.stringContaining('Clase de yoga') as string,
    });
    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
    expect(notificaciones.crear).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      accountId: residentes[1].accountId,
      tipo: 'actividad',
      titulo: 'Nueva actividad en Torres del Parque: Clase de yoga',
    });
  });

  it('el botón apunta al portal de actividades con un enlace de acceso por residente', async () => {
    const { servicio, enlaces, residentes, correo } = montar();

    await servicio.crear(dtoBase);

    expect(enlaces.construir).toHaveBeenCalledWith(
      residentes[0].accountId,
      COPROPIEDAD.toString(),
      `/portal/actividades?abrir=${ACTIVIDAD.toString()}`,
    );
    const { html } = correo.enviar.mock.calls[0][0];
    expect(html).toContain('https://app.test/auth/enlace?t=1');
    expect(html).toContain('Confirmar asistencia');
  });

  it('si no se puede emitir enlace, el correo sale igual pero sin botón', async () => {
    const { servicio, enlaces, correo, notificaciones } = montar();
    enlaces.construir.mockResolvedValue(null);

    await servicio.crear(dtoBase);

    const { html } = correo.enviar.mock.calls[0][0];
    expect(html).not.toContain('Confirmar asistencia');
    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
  });

  it('si no hay residentes con cuenta no avisa a nadie pero igual crea la actividad', async () => {
    const { servicio, directorio, correo, copropiedades } = montar();
    directorio.residentes.mockResolvedValue([]);

    const creada = await servicio.crear(dtoBase);

    expect(creada.titulo).toBe('Clase de yoga');
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(copropiedades.findById).not.toHaveBeenCalled();
  });

  it('un fallo al listar los residentes no impide que la actividad se cree', async () => {
    const { servicio, directorio } = montar();
    directorio.residentes.mockRejectedValue(new Error('mongo down'));

    const creada = await servicio.crear(dtoBase);

    expect(creada.titulo).toBe('Clase de yoga');
  });

  it('un correo que falla (false) no corta el aviso in-app de ese residente', async () => {
    const { servicio, correo, notificaciones } = montar();
    correo.enviar.mockResolvedValue(false);

    await servicio.crear(dtoBase);

    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
  });

  it('un residente cuyo envío revienta no detiene a los demás', async () => {
    const { servicio, directorio, correo, notificaciones } = montar();
    const cuatro = [residente(1), residente(2), residente(3), residente(4)];
    directorio.residentes.mockResolvedValue(cuatro);
    correo.enviar.mockImplementation((mensaje: { para: string }) =>
      mensaje.para === cuatro[1].email
        ? Promise.reject(new Error('smtp caído'))
        : Promise.resolve(true),
    );

    const creada = await servicio.crear(dtoBase);

    expect(creada.codigo).toBe('ACT-001');
    expect(correo.enviar).toHaveBeenCalledTimes(4);
    expect(notificaciones.crear).toHaveBeenCalledTimes(3);
    const avisados = notificaciones.crear.mock.calls.map(
      ([entrada]) => (entrada as { accountId: string }).accountId,
    );
    expect(avisados).not.toContain(cuatro[1].accountId);
  });

  it('nunca hay más de 10 envíos en vuelo y todos los residentes se procesan', async () => {
    const { servicio, directorio, correo } = montar();
    const total = 25;
    directorio.residentes.mockResolvedValue(
      Array.from({ length: total }, (_, i) => residente(i)),
    );
    let enVuelo = 0;
    let maximo = 0;
    correo.enviar.mockImplementation(async () => {
      enVuelo += 1;
      maximo = Math.max(maximo, enVuelo);
      await new Promise<void>((resolver) => setImmediate(resolver));
      enVuelo -= 1;
      return true;
    });

    await servicio.crear(dtoBase);

    expect(ENVIOS_SIMULTANEOS).toBe(10);
    expect(correo.enviar).toHaveBeenCalledTimes(total);
    expect(maximo).toBe(10);
  });
});

describe('ActividadesService — listas', () => {
  it('filtra por la copropiedad activa, ordena por fecha descendente y aplica categoría y estado', async () => {
    const { servicio, actividades } = montar();
    const q = consulta([actividadDoc()]);
    actividades.find.mockReturnValue(q);

    const lista = await servicio.listar({
      categoria: 'salud',
      estado: 'proximo',
    });

    expect(actividades.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      categoria: 'salud',
      estado: 'proximo',
    });
    expect(q.sort).toHaveBeenCalledWith({ fecha: -1 });
    expect(lista).toHaveLength(1);
  });

  it('todos no filtra', async () => {
    const { servicio, actividades } = montar();

    await servicio.listar({ categoria: 'todos', estado: 'todos' });

    expect(actividades.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
    });
  });

  it('la lista de personal no trae asistiendo ni expone los ids de asistentes', async () => {
    const { servicio, actividades } = montar();
    actividades.find.mockReturnValue(
      consulta([actividadDoc({ participantesIds: [CUENTA] })]),
    );

    const [item] = await servicio.listar({});

    expect(item).not.toHaveProperty('asistiendo');
    expect(item).not.toHaveProperty('participantesIds');
    expect(item.asistentes).toBe(1);
  });

  it('la lista del residente marca asistiendo según si la cuenta está inscrita', async () => {
    const { servicio, actividades } = montar();
    actividades.find.mockReturnValue(
      consulta([
        actividadDoc({ participantesIds: [CUENTA, OTRA_CUENTA] }),
        actividadDoc({ participantesIds: [OTRA_CUENTA] }),
      ]),
    );

    const lista = await servicio.listarParaResidente({}, usuario(CUENTA));

    expect(lista.map((a) => a.asistiendo)).toEqual([true, false]);
  });

  it('sin cuenta asociada, el residente nunca figura como asistiendo', async () => {
    const { servicio, actividades } = montar();
    actividades.find.mockReturnValue(
      consulta([actividadDoc({ participantesIds: [CUENTA] })]),
    );

    const [item] = await servicio.listarParaResidente({}, usuario());

    expect(item.asistiendo).toBe(false);
  });
});

describe('ActividadesService.actualizar y eliminar', () => {
  it('actualiza por id Y copropiedad, solo con lo enviado', async () => {
    const { servicio, actividades } = montar();

    await servicio.actualizar(ACTIVIDAD.toString(), { capacidad: 30 });

    expect(actividades.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ACTIVIDAD.toString(), copropiedadId: COPROPIEDAD },
      { $set: { capacidad: 30 } },
      { new: true },
    );
  });

  it('responde 404 si la actividad no existe en la copropiedad activa', async () => {
    const { servicio, actividades } = montar();
    actividades.findOneAndUpdate.mockReturnValue(consulta(null));
    actividades.findOneAndDelete.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(ACTIVIDAD.toString(), { titulo: 'x' }),
    ).rejects.toThrow(NotFoundException);
    await expect(servicio.eliminar(ACTIVIDAD.toString())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('borra por id Y copropiedad', async () => {
    const { servicio, actividades } = montar();

    const resultado = await servicio.eliminar(ACTIVIDAD.toString());

    expect(actividades.findOneAndDelete).toHaveBeenCalledWith({
      _id: ACTIVIDAD.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(resultado).toEqual({ id: ACTIVIDAD.toString() });
  });

  it('un id mal formado es 404 sin tocar la base', async () => {
    const { servicio, actividades } = montar();

    await expect(servicio.actualizar('xyz', {})).rejects.toThrow(
      NotFoundException,
    );
    await expect(servicio.eliminar('xyz')).rejects.toThrow(NotFoundException);
    expect(actividades.findOneAndUpdate).not.toHaveBeenCalled();
    expect(actividades.findOneAndDelete).not.toHaveBeenCalled();
  });
});

describe('ActividadesService.asistir / dejarDeAsistir — explícitas y atómicas', () => {
  const ABIERTA = { $in: ['proximo', 'en_curso'] };

  it('asistir: $addToSet con el cupo y el estado verificados dentro del filtro, no en memoria', async () => {
    const { servicio, actividades } = montar();
    actividades.findOneAndUpdate.mockReturnValueOnce(
      consulta(actividadDoc({ participantesIds: [OTRA_CUENTA, CUENTA] })),
    );

    const resultado = await servicio.asistir(
      ACTIVIDAD.toString(),
      usuario(CUENTA),
    );

    expect(resultado).toEqual({ asistiendo: true, asistentes: 2 });
    expect(actividades.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: ACTIVIDAD.toString(),
        copropiedadId: COPROPIEDAD,
        estado: ABIERTA,
        participantesIds: { $ne: CUENTA },
        $expr: { $lt: [{ $size: '$participantesIds' }, '$capacidad'] },
      },
      { $addToSet: { participantesIds: CUENTA } },
      { new: true },
    );
    expect(actividades.findOne).not.toHaveBeenCalled();
  });

  it('doble clic en asistir: la segunda vez informa asistiendo, NUNCA da de baja', async () => {
    const { servicio, actividades } = montar();
    actividades.findOneAndUpdate.mockReturnValue(consulta(null));
    actividades.findOne.mockReturnValue(
      consulta(actividadDoc({ capacidad: 1, participantesIds: [CUENTA] })),
    );

    const resultado = await servicio.asistir(
      ACTIVIDAD.toString(),
      usuario(CUENTA),
    );

    expect(resultado).toEqual({ asistiendo: true, asistentes: 1 });
    const operaciones = actividades.findOneAndUpdate.mock.calls.map(
      ([, cambio]) => Object.keys(cambio as object)[0],
    );
    expect(operaciones).not.toContain('$pull');
  });

  it.each(['finalizado', 'cancelado'])(
    'asistir a una actividad %s es 409',
    async (estado) => {
      const { servicio, actividades } = montar();
      actividades.findOneAndUpdate.mockReturnValue(consulta(null));
      actividades.findOne.mockReturnValue(
        consulta(actividadDoc({ estado, participantesIds: [] })),
      );

      await expect(
        servicio.asistir(ACTIVIDAD.toString(), usuario(CUENTA)),
      ).rejects.toThrow(ConflictException);
    },
  );

  it('cupo lleno (o capacidad 0): 400', async () => {
    const { servicio, actividades } = montar();
    actividades.findOneAndUpdate.mockReturnValue(consulta(null));
    actividades.findOne.mockReturnValue(
      consulta(actividadDoc({ capacidad: 0, participantesIds: [] })),
    );

    await expect(
      servicio.asistir(ACTIVIDAD.toString(), usuario(CUENTA)),
    ).rejects.toThrow(
      new BadRequestException('La actividad ya alcanzó su capacidad máxima'),
    );
  });

  it('la actividad no existe en esta copropiedad: 404, no "cupo lleno"', async () => {
    const { servicio, actividades } = montar();
    actividades.findOneAndUpdate.mockReturnValue(consulta(null));
    actividades.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.asistir(ACTIVIDAD.toString(), usuario(CUENTA)),
    ).rejects.toThrow(NotFoundException);
    expect(actividades.findOne).toHaveBeenCalledWith({
      _id: ACTIVIDAD.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('dejarDeAsistir: $pull solo en una actividad abierta, idempotente', async () => {
    const { servicio, actividades } = montar();
    actividades.findOneAndUpdate.mockReturnValueOnce(
      consulta(actividadDoc({ participantesIds: [OTRA_CUENTA] })),
    );

    const resultado = await servicio.dejarDeAsistir(
      ACTIVIDAD.toString(),
      usuario(CUENTA),
    );

    expect(resultado).toEqual({ asistiendo: false, asistentes: 1 });
    expect(actividades.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: ACTIVIDAD.toString(),
        copropiedadId: COPROPIEDAD,
        estado: ABIERTA,
      },
      { $pull: { participantesIds: CUENTA } },
      { new: true },
    );
  });

  it('dejarDeAsistir en una actividad finalizada: 409 (la asistencia histórica no se reescribe)', async () => {
    const { servicio, actividades } = montar();
    actividades.findOneAndUpdate.mockReturnValue(consulta(null));
    actividades.findOne.mockReturnValue(
      consulta(
        actividadDoc({ estado: 'finalizado', participantesIds: [CUENTA] }),
      ),
    );

    await expect(
      servicio.dejarDeAsistir(ACTIVIDAD.toString(), usuario(CUENTA)),
    ).rejects.toThrow(ConflictException);
  });

  it('sin cuenta asociada: 400 y no toca la base', async () => {
    const { servicio, actividades } = montar();

    await expect(
      servicio.asistir(ACTIVIDAD.toString(), usuario()),
    ).rejects.toThrow(
      new BadRequestException('Usuario no tiene cuenta asociada'),
    );
    await expect(
      servicio.dejarDeAsistir(ACTIVIDAD.toString(), {
        ...usuario(),
        accountId: 'cuenta-1',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(actividades.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un id de actividad mal formado es 404 sin tocar la base', async () => {
    const { servicio, actividades } = montar();

    await expect(servicio.asistir('xyz', usuario(CUENTA))).rejects.toThrow(
      NotFoundException,
    );
    expect(actividades.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('ActividadesService.finalizarPasadas — cron', () => {
  it('corre bajo el lock con la clave y el TTL previstos', async () => {
    const { servicio, lock } = montar();

    await servicio.finalizarPasadas();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'cron:actividades:finalizar-pasadas',
      600_000,
      expect.any(Function),
    );
  });

  describe('el día de corte es el de Bogotá (la fecha se guarda como medianoche UTC del día)', () => {
    afterEach(() => jest.restoreAllMocks());

    const corteA = async (ahoraReal: string) => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse(ahoraReal));
      const { servicio, actividades } = montar();
      await servicio.finalizarPasadas();
      expect(actividades.updateMany).toHaveBeenCalledTimes(1);
      return actividades.updateMany.mock.calls[0] as [
        { estado: { $in: string[] }; fecha: { $lt: Date } },
        { estado: string },
      ];
    };

    it('finaliza las próximas y en curso de días anteriores al de hoy en Bogotá', async () => {
      // 00:05 in Bogotá on 11 Sep = 05:05 UTC.
      const [filtro, cambio] = await corteA('2026-09-11T05:05:00.000Z');

      expect(filtro.estado).toEqual({ $in: ['proximo', 'en_curso'] });
      expect(filtro.fecha.$lt.toISOString()).toBe('2026-09-11T00:00:00.000Z');
      expect(cambio).toEqual({ estado: 'finalizado' });
    });

    it('a las 19:30 de Bogotá (00:30 UTC del día siguiente) una actividad de esa noche NO se finaliza', async () => {
      const [filtro] = await corteA('2026-09-11T00:30:00.000Z');
      const actividadDeEstaNoche = new Date('2026-09-10T00:00:00.000Z');

      expect(filtro.fecha.$lt.toISOString()).toBe('2026-09-10T00:00:00.000Z');
      expect(actividadDeEstaNoche < filtro.fecha.$lt).toBe(false);
    });
  });

  it('el cron corre a la medianoche de Bogotá, no a la del servidor (UTC)', () => {
    // The decorator stores its options on the method itself (read, not called).
    const metodo = Object.getOwnPropertyDescriptor(
      ActividadesService.prototype,
      'finalizarPasadas',
    )?.value as object;
    const opciones = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', metodo) as {
      cronTime: string;
      timeZone?: string;
    };

    expect(opciones.cronTime).toBe('0 0 * * *');
    expect(opciones.timeZone).toBe('America/Bogota');
  });

  it('si otra instancia tiene el lock no ejecuta el cambio', async () => {
    const { servicio, actividades, lock } = montar();
    lock.runExclusive.mockResolvedValue(false);

    await servicio.finalizarPasadas();

    expect(actividades.updateMany).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo de la base se registra y se traga', async () => {
    const { servicio, actividades } = montar();
    actividades.updateMany.mockReturnValue({
      exec: jest.fn().mockRejectedValue(new Error('mongo down')),
    });

    await expect(servicio.finalizarPasadas()).resolves.toBeUndefined();
  });

  it('onApplicationBootstrap delega la pasada inicial en el helper de arranque', async () => {
    const { servicio, actividades } = montar();
    const arrancar = jest.mocked(ejecutarAlArrancar);
    arrancar.mockClear();

    servicio.onApplicationBootstrap();

    expect(arrancar).toHaveBeenCalledTimes(1);
    const [, nombre, tarea] = arrancar.mock.calls[0];
    expect(nombre).toBe('finalización de actividades pasadas');
    // The task it hands over is the same locked pass the cron runs.
    await tarea();
    expect(actividades.updateMany).toHaveBeenCalledTimes(1);
  });
});
