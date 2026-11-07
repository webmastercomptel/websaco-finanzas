import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { Destinatario } from '../../common/directorio/directorio.service';
import { TareasService } from './tareas.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  populate: jest.Mock;
  sort: jest.Mock;
  select: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.populate = jest.fn().mockReturnValue(q);
  q.sort = jest.fn().mockReturnValue(q);
  q.select = jest.fn().mockReturnValue(q);
  return q;
};

type ModeloTareas = jest.Mock & {
  find: jest.Mock;
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
  findOneAndDelete: jest.Mock;
};

/** The `[filter, operation, options]` of the n-th `findOneAndUpdate` call. */
const llamadaActualizar = (modelo: ModeloTareas, n = 0) => {
  const [filtro, operacion, opciones] = modelo.findOneAndUpdate.mock.calls[
    n
  ] as [
    Record<string, unknown>,
    {
      $set?: Record<string, unknown>;
      $push?: Record<string, unknown>;
    } & Record<string, unknown>,
    unknown,
  ];
  return { filtro, operacion, opciones };
};

const COPROPIEDAD = new Types.ObjectId();
const ASIGNADO = new Types.ObjectId();
const OTRO = new Types.ObjectId();
const TAREA = new Types.ObjectId();

const actor = (
  accountId: Types.ObjectId | undefined,
  extra: Partial<IRequestUser> = {},
): IRequestUser => ({
  uid: 'uid',
  email: 'x@y.co',
  nombre: 'Admin',
  accountId: accountId?.toString(),
  ...extra,
});

const GESTOR = (id: Types.ObjectId = OTRO) =>
  actor(id, { nombre: 'Gestor', permissions: ['tareas.gestionar'] });
const ASIGNADO_USER = actor(ASIGNADO, {
  nombre: 'María',
  permissions: ['tareas.actualizar'],
});

const dtoCrear = {
  titulo: 'Limpiar zona común',
  categoria: 'limpieza' as const,
  asignadosIds: [ASIGNADO.toString()],
};

function tareaDoc(extra: Record<string, unknown> = {}) {
  return {
    _id: TAREA,
    copropiedadId: COPROPIEDAD,
    titulo: 'Limpiar zona común',
    descripcion: '',
    categoria: 'limpieza',
    prioridad: 'normal',
    estado: 'pendiente',
    asignadosIds: [ASIGNADO],
    progreso: null,
    fechaLimite: null,
    historial: [],
    observaciones: [],
    ...extra,
  };
}

function montar() {
  const tareas = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) => {
      const instancia: Record<string, unknown> = { ...doc, _id: TAREA };
      instancia.save = jest.fn().mockResolvedValue(instancia);
      return instancia;
    }) as ModeloTareas;
  tareas.find = jest.fn().mockReturnValue(consulta([]));
  tareas.findOne = jest.fn().mockReturnValue(consulta(tareaDoc()));
  tareas.findOneAndUpdate = jest.fn().mockReturnValue(consulta(tareaDoc()));
  tareas.findOneAndDelete = jest.fn().mockReturnValue(consulta(tareaDoc()));

  const copropiedades = {
    findById: jest
      .fn()
      .mockReturnValue(consulta({ nombre: 'Torres del Parque' })),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  // Every account is an active back-office user unless a test says otherwise.
  const directorio = {
    destinatarioDe: jest
      .fn<Promise<Destinatario | null>, [string, Types.ObjectId, string]>()
      .mockImplementation((accountId) =>
        Promise.resolve({
          accountId,
          email: 'juan@example.com',
          nombre: 'Juan Pérez',
          perfil: 'personal',
        }),
      ),
  };
  const correo = { enviar: jest.fn().mockResolvedValue(true) };
  const enlaces = {
    construir: jest.fn().mockResolvedValue('https://app.test/auth/enlace?t=1'),
  };
  const notificaciones = { crear: jest.fn().mockResolvedValue(undefined) };

  const servicio = new TareasService(
    tareas as never,
    copropiedades as never,
    tenant as never,
    directorio as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
  );
  return {
    servicio,
    tareas,
    copropiedades,
    tenant,
    directorio,
    correo,
    enlaces,
    notificaciones,
  };
}

/** The task as it is stored before an update, with the given assignees. */
const conAsignados = (m: ReturnType<typeof montar>, ids: Types.ObjectId[]) =>
  m.tareas.findOne.mockReturnValue(consulta(tareaDoc({ asignadosIds: ids })));

describe('TareasService — notificación de asignación de tarea', () => {
  it('asignar a quien no es personal de la copropiedad (sin cuenta, inactivo o de otro edificio) es 400 y no se crea nada', async () => {
    const m = montar();
    m.directorio.destinatarioDe.mockResolvedValue(null);

    await expect(m.servicio.crear(dtoCrear, actor(OTRO))).rejects.toThrow(
      BadRequestException,
    );

    expect(m.tareas).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(m.notificaciones.crear).not.toHaveBeenCalled();
    expect(m.enlaces.construir).not.toHaveBeenCalled();
  });

  it('asignar a un residente (sin pantalla de tareas) es 400', async () => {
    const m = montar();
    m.directorio.destinatarioDe.mockImplementation((accountId: string) =>
      Promise.resolve({
        accountId,
        email: 'vecino@example.com',
        nombre: 'Vecino',
        perfil: 'residente',
      }),
    );

    await expect(m.servicio.crear(dtoCrear, actor(OTRO))).rejects.toThrow(
      BadRequestException,
    );

    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(m.notificaciones.crear).not.toHaveBeenCalled();
    expect(m.enlaces.construir).not.toHaveBeenCalled();
  });

  it('un residente quitado de una tarea no recibe la notificación de desasignación', async () => {
    const m = montar();
    m.directorio.destinatarioDe.mockImplementation((accountId: string) =>
      Promise.resolve({
        accountId,
        email: 'vecino@example.com',
        nombre: 'Vecino',
        perfil: 'residente',
      }),
    );

    await m.servicio.actualizar(
      TAREA.toString(),
      { asignadosIds: [] },
      actor(OTRO),
    );

    expect(m.notificaciones.crear).not.toHaveBeenCalled();
  });

  it('si el asignado quitado no puede leer Tarea, no se le crea la notificación de desasignación', async () => {
    const m = montar();
    m.directorio.destinatarioDe.mockResolvedValue(null);

    await m.servicio.actualizar(
      TAREA.toString(),
      { asignadosIds: [] },
      actor(OTRO),
    );

    expect(m.notificaciones.crear).not.toHaveBeenCalled();
    expect(m.enlaces.construir).not.toHaveBeenCalled();
  });

  it('consulta el directorio con el asignado, la copropiedad activa y la materia Tarea', async () => {
    const m = montar();

    await m.servicio.crear(dtoCrear, actor(OTRO));

    expect(m.directorio.destinatarioDe).toHaveBeenCalledWith(
      ASIGNADO.toString(),
      COPROPIEDAD,
      'Tarea',
    );
  });

  it('al crear una tarea con asignado (que no es quien la crea), le envía un email con el título', async () => {
    const m = montar();

    await m.servicio.crear(dtoCrear, actor(OTRO));

    expect(m.correo.enviar).toHaveBeenCalledWith({
      para: 'juan@example.com',
      asunto: 'Te asignaron una tarea en Torres del Parque: Limpiar zona común',
      html: expect.stringContaining('Limpiar zona común') as string,
    });
  });

  it('el enlace de acceso apunta a la tarea y va como botón del email', async () => {
    const m = montar();

    await m.servicio.crear(dtoCrear, actor(OTRO));

    expect(m.enlaces.construir).toHaveBeenCalledWith(
      ASIGNADO.toString(),
      COPROPIEDAD.toString(),
      `/tareas?abrir=${TAREA.toString()}`,
    );
    const [mensaje] = m.correo.enviar.mock.calls[0] as [{ html: string }];
    expect(mensaje.html).toContain('https://app.test/auth/enlace?t=1');
    expect(mensaje.html).toContain('Ver mi tarea');
  });

  it('si no se puede emitir enlace de acceso (null), igual envía el email, sin botón', async () => {
    const m = montar();
    m.enlaces.construir.mockResolvedValue(null);

    await m.servicio.crear(dtoCrear, actor(OTRO));

    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
    const [mensaje] = m.correo.enviar.mock.calls[0] as [{ html: string }];
    expect(mensaje.html).not.toContain('Ver mi tarea');
    expect(m.notificaciones.crear).toHaveBeenCalledTimes(1);
  });

  it('al crear una tarea con varios asignados, notifica a cada uno (menos a quien la crea)', async () => {
    const m = montar();
    const tercero = new Types.ObjectId();

    await m.servicio.crear(
      {
        ...dtoCrear,
        asignadosIds: [
          ASIGNADO.toString(),
          OTRO.toString(),
          tercero.toString(),
        ],
      },
      actor(OTRO),
    );

    expect(m.correo.enviar).toHaveBeenCalledTimes(2); // ASIGNADO y tercero, no OTRO (quien la crea)
  });

  it('si el creador se autoasigna la tarea, no se notifica a sí mismo', async () => {
    const m = montar();

    await m.servicio.crear(
      { ...dtoCrear, asignadosIds: [OTRO.toString()] },
      actor(OTRO),
    );

    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(m.notificaciones.crear).not.toHaveBeenCalled();
  });

  it('al reasignar una tarea existente a otra persona, notifica al nuevo asignado', async () => {
    const m = montar();

    await m.servicio.actualizar(
      TAREA.toString(),
      { asignadosIds: [OTRO.toString()] },
      actor(new Types.ObjectId()),
    );

    expect(m.directorio.destinatarioDe).toHaveBeenCalledWith(
      OTRO.toString(),
      COPROPIEDAD,
      'Tarea',
    );
    expect(m.correo.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ para: 'juan@example.com' }),
    );
  });

  it('si se quita toda la asignación (asignadosIds: []), no se notifica a nadie por email', async () => {
    const m = montar();

    await m.servicio.actualizar(
      TAREA.toString(),
      { asignadosIds: [] },
      actor(OTRO),
    );

    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('si la reasignación no cambia el asignado, no se notifica de nuevo', async () => {
    const m = montar();

    await m.servicio.actualizar(
      TAREA.toString(),
      { asignadosIds: [ASIGNADO.toString()] },
      actor(OTRO),
    );

    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(m.notificaciones.crear).not.toHaveBeenCalled();
  });

  describe('notificación in-app', () => {
    it('al crear una tarea con asignado, crea una notificación tipo=tarea para el asignado', async () => {
      const m = montar();

      await m.servicio.crear(dtoCrear, actor(OTRO));

      expect(m.notificaciones.crear).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD,
        accountId: ASIGNADO.toString(),
        tipo: 'tarea',
        titulo: expect.stringContaining('Limpiar zona común') as string,
      });
    });

    it('al reasignar una tarea existente, crea una notificación tipo=tarea para el nuevo asignado', async () => {
      const m = montar();

      await m.servicio.actualizar(
        TAREA.toString(),
        { asignadosIds: [OTRO.toString()] },
        actor(new Types.ObjectId()),
      );

      expect(m.notificaciones.crear).toHaveBeenCalledWith(
        expect.objectContaining({
          copropiedadId: COPROPIEDAD,
          accountId: OTRO.toString(),
          tipo: 'tarea',
          titulo: expect.stringContaining('Limpiar zona común') as string,
        }),
      );
    });

    it('si se quita la asignación (asignadosIds: []), crea una notificación in-app de desasignación (no la de asignación)', async () => {
      const m = montar();

      await m.servicio.actualizar(
        TAREA.toString(),
        { asignadosIds: [] },
        actor(OTRO),
      );

      expect(m.notificaciones.crear).toHaveBeenCalledWith(
        expect.objectContaining({
          copropiedadId: COPROPIEDAD,
          accountId: ASIGNADO.toString(),
          tipo: 'tarea',
          titulo: expect.stringContaining('Te quitaron') as string,
        }),
      );
    });
  });

  it('al reasignar de [A,B] a [B,C], notifica a C (agregado) y no vuelve a notificar a B', async () => {
    const m = montar();
    const c = new Types.ObjectId();
    conAsignados(m, [ASIGNADO, OTRO]);

    await m.servicio.actualizar(
      TAREA.toString(),
      { asignadosIds: [OTRO.toString(), c.toString()] },
      actor(new Types.ObjectId()),
    );

    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
    expect(m.directorio.destinatarioDe).toHaveBeenCalledWith(
      c.toString(),
      COPROPIEDAD,
      'Tarea',
    );
  });

  it('al quitar un asignado sin agregar ninguno, no envía email pero crea una notificación in-app de desasignación', async () => {
    const m = montar();
    conAsignados(m, [ASIGNADO, OTRO]);

    await m.servicio.actualizar(
      TAREA.toString(),
      { asignadosIds: [ASIGNADO.toString()] }, // se quita a OTRO
      actor(new Types.ObjectId()),
    );

    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(m.notificaciones.crear).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: OTRO.toString(),
        tipo: 'tarea',
        titulo: expect.stringContaining('Te quitaron') as string,
      }),
    );
  });

  it('si el envío del email falla, igual deja la notificación in-app y no lanza', async () => {
    const m = montar();
    m.correo.enviar.mockResolvedValue(false);

    await expect(
      m.servicio.crear(dtoCrear, actor(OTRO)),
    ).resolves.toBeDefined();

    expect(m.notificaciones.crear).toHaveBeenCalledTimes(1);
  });

  it('si el directorio falla al validar los asignados, no se crea nada (no se asigna a ciegas)', async () => {
    const m = montar();
    m.directorio.destinatarioDe.mockRejectedValue(new Error('sin base'));

    await expect(m.servicio.crear(dtoCrear, actor(OTRO))).rejects.toThrow(
      'sin base',
    );
    expect(m.tareas).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('al editar, un asignado NUEVO que no es personal de la copropiedad es 400 y no se escribe', async () => {
    const m = montar();
    conAsignados(m, []);
    m.directorio.destinatarioDe.mockResolvedValue(null);

    await expect(
      m.servicio.actualizar(
        TAREA.toString(),
        { asignadosIds: [OTRO.toString()] },
        actor(OTRO),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(m.tareas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('si no hay copropiedad con nombre, el email igual sale (nombre vacío)', async () => {
    const m = montar();
    m.copropiedades.findById.mockReturnValue(consulta(null));

    await m.servicio.crear(dtoCrear, actor(OTRO));

    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('el nombre de la copropiedad se lee por su propio id, solo el campo nombre', async () => {
    const m = montar();

    await m.servicio.crear(dtoCrear, actor(OTRO));

    expect(m.copropiedades.findById).toHaveBeenCalledWith(COPROPIEDAD);
    const query = m.copropiedades.findById.mock.results[0].value as Consulta;
    expect(query.select).toHaveBeenCalledWith('nombre');
  });
});

describe('TareasService.crear', () => {
  it('guarda en la copropiedad activa (nunca la del payload) y siembra el historial', async () => {
    const m = montar();

    const resultado = await m.servicio.crear(dtoCrear, actor(OTRO));

    const [documento] = m.tareas.mock.calls[0] as [
      {
        copropiedadId: Types.ObjectId;
        asignadosIds: Types.ObjectId[];
        historial: Array<{ accion: string; usuario: string }>;
      },
    ];
    expect(documento.copropiedadId).toBe(COPROPIEDAD);
    expect(documento.asignadosIds).toEqual([ASIGNADO]);
    expect(documento.historial.map((h) => h.accion)).toEqual([
      'Creó la tarea',
      'Asignó la tarea inicialmente',
    ]);
    expect(documento.historial[0].usuario).toBe('Admin');
    expect(resultado.id).toBe(TAREA.toString());
  });

  it('sin asignados, el historial solo tiene la creación', async () => {
    const m = montar();

    await m.servicio.crear(
      { ...dtoCrear, asignadosIds: undefined },
      actor(OTRO),
    );

    const [documento] = m.tareas.mock.calls[0] as [
      { historial: Array<{ accion: string }> },
    ];
    expect(documento.historial.map((h) => h.accion)).toEqual(['Creó la tarea']);
  });

  it('usa "Usuario" como autor del historial cuando el actor no tiene nombre', async () => {
    const m = montar();

    await m.servicio.crear(dtoCrear, actor(OTRO, { nombre: undefined }));

    const [documento] = m.tareas.mock.calls[0] as [
      { historial: Array<{ usuario: string }> },
    ];
    expect(documento.historial[0].usuario).toBe('Usuario');
  });

  it('relee la tarea con sus asignados por id Y copropiedad (nunca findById)', async () => {
    const m = montar();

    await m.servicio.crear(dtoCrear, actor(OTRO));

    expect(m.tareas.findOne).toHaveBeenCalledWith({
      _id: TAREA,
      copropiedadId: COPROPIEDAD,
    });
  });

  it('aplica los valores por defecto del contrato', async () => {
    const m = montar();

    await m.servicio.crear({ titulo: 'Algo', categoria: 'admin' }, actor(OTRO));

    const [documentoNuevo] = m.tareas.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(documentoNuevo).toMatchObject({
      descripcion: '',
      prioridad: 'normal',
      estado: 'pendiente',
      progreso: null,
      fechaLimite: null,
      orden: 0,
      asignadosIds: [],
    });
  });
});

describe('TareasService.actualizar', () => {
  it('busca la tarea por id y copropiedad activa', async () => {
    const m = montar();

    await m.servicio.actualizar(
      TAREA.toString(),
      { titulo: 'Nuevo' },
      actor(OTRO),
    );

    expect(m.tareas.findOne).toHaveBeenCalledWith({
      _id: TAREA.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(llamadaActualizar(m.tareas).filtro).toEqual({
      _id: TAREA.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('si la tarea no existe en la copropiedad activa, lanza NotFoundException y no escribe', async () => {
    const m = montar();
    m.tareas.findOne.mockReturnValue(consulta(null));

    await expect(
      m.servicio.actualizar(TAREA.toString(), { titulo: 'x' }, actor(OTRO)),
    ).rejects.toThrow(NotFoundException);
    expect(m.tareas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un id mal formado responde 404 sin tocar la base', async () => {
    const m = montar();

    await expect(
      m.servicio.actualizar('no-es-un-id', { titulo: 'x' }, actor(OTRO)),
    ).rejects.toThrow(NotFoundException);
    expect(m.tareas.findOne).not.toHaveBeenCalled();
  });

  it('si la tarea desaparece entre la lectura y la escritura, lanza NotFoundException', async () => {
    const m = montar();
    m.tareas.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      m.servicio.actualizar(TAREA.toString(), { titulo: 'x' }, actor(OTRO)),
    ).rejects.toThrow(NotFoundException);
  });

  describe('historial atómico', () => {
    it('usa $push (con $each) para las nuevas entradas en vez de reescribir el array completo', async () => {
      const m = montar();

      await m.servicio.actualizar(
        TAREA.toString(),
        { estado: 'completado' },
        actor(OTRO),
      );

      const { filtro, operacion, opciones } = llamadaActualizar(m.tareas);
      expect(filtro).toEqual({
        _id: TAREA.toString(),
        copropiedadId: COPROPIEDAD,
      });
      expect(operacion.$set).toEqual(
        expect.objectContaining({ estado: 'completado', progreso: 100 }),
      );
      expect(operacion.$push).toEqual({
        historial: {
          $each: [
            expect.objectContaining({
              accion: 'Movió la tarea a completado',
              usuario: 'Admin',
            }),
          ],
        },
      });
      expect(opciones).toEqual({ new: true });
      // Solo agrega: nunca reemplaza el array, que pisaría un $push concurrente
      // de completar()/agregarObservacion().
      expect(operacion.$set?.historial).toBeUndefined();
      expect(operacion.historial).toBeUndefined();
    });

    it('cuando no hay cambios que auditar, no incluye $push en absoluto', async () => {
      const m = montar();

      await m.servicio.actualizar(
        TAREA.toString(),
        { titulo: 'Limpiar zona común' }, // igual al título existente
        actor(OTRO),
      );

      expect(llamadaActualizar(m.tareas).operacion.$push).toBeUndefined();
    });

    it('registra el cambio de detalles cuando cambia el título o la descripción', async () => {
      const m = montar();

      await m.servicio.actualizar(
        TAREA.toString(),
        { descripcion: 'Con detalle' },
        actor(OTRO),
      );

      expect(llamadaActualizar(m.tareas).operacion.$push).toEqual({
        historial: {
          $each: [
            expect.objectContaining({
              accion: 'Actualizó los detalles de la tarea',
            }),
          ],
        },
      });
    });

    it('registra por separado a quién se asignó y a quién se quitó', async () => {
      const m = montar();

      await m.servicio.actualizar(
        TAREA.toString(),
        { asignadosIds: [OTRO.toString()] },
        actor(new Types.ObjectId()),
      );

      const acciones = (
        llamadaActualizar(m.tareas).operacion.$push as {
          historial: { $each: Array<{ accion: string }> };
        }
      ).historial.$each.map((e) => e.accion);
      expect(acciones).toEqual([
        'Asignó la tarea a nuevos responsables',
        'Quitó responsables de la tarea',
      ]);
    });
  });

  describe('progreso automático según el estado', () => {
    it.each([
      ['completado', 100],
      ['en_progreso', 50],
      ['pendiente', 0],
    ] as const)(
      'al mover a %s fija el progreso en %i',
      async (estado, progreso) => {
        const m = montar();
        // Parte de otra columna para que el estado realmente cambie.
        m.tareas.findOne.mockReturnValue(
          consulta(
            tareaDoc({
              estado: estado === 'pendiente' ? 'completado' : 'pendiente',
            }),
          ),
        );

        await m.servicio.actualizar(TAREA.toString(), { estado }, actor(OTRO));

        expect(llamadaActualizar(m.tareas).operacion.$set).toEqual(
          expect.objectContaining({ estado, progreso }),
        );
      },
    );

    it('si el estado no cambia, no toca el progreso ni registra el movimiento', async () => {
      const m = montar();

      await m.servicio.actualizar(
        TAREA.toString(),
        { estado: 'pendiente', orden: 3 },
        actor(OTRO),
      );

      const { operacion } = llamadaActualizar(m.tareas);
      expect(operacion.$set).toEqual({ estado: 'pendiente', orden: 3 });
      expect(operacion.$push).toBeUndefined();
    });
  });

  it('fechaLimite null borra la fecha límite', async () => {
    const m = montar();

    await m.servicio.actualizar(
      TAREA.toString(),
      { fechaLimite: null },
      actor(OTRO),
    );

    expect(llamadaActualizar(m.tareas).operacion.$set).toEqual({
      fechaLimite: null,
    });
  });
});

describe('TareasService.listar', () => {
  it('para un usuario sin tareas.gestionar, filtra por asignadosIds (Mongo lo resuelve como "el array contiene este id")', async () => {
    const m = montar();

    await m.servicio.listar({}, ASIGNADO_USER);

    expect(m.tareas.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      asignadosIds: ASIGNADO,
    });
  });

  it('un no gestor no puede leer las tareas de otros: su filtro lo ata a su propia cuenta, no a la de otro', async () => {
    const m = montar();

    await m.servicio.listar({}, actor(OTRO, { permissions: ['tareas.ver'] }));

    const [filtro] = m.tareas.find.mock.calls[0] as [
      { asignadosIds: Types.ObjectId },
    ];
    expect(filtro.asignadosIds).toEqual(OTRO);
    expect(filtro.asignadosIds).not.toEqual(ASIGNADO);
  });

  it('un no gestor sin cuenta identificable no ve nada (no degrada a "ve todo")', async () => {
    const m = montar();

    const resultado = await m.servicio.listar(
      {},
      actor(undefined, { permissions: ['tareas.ver'] }),
    );

    expect(resultado).toEqual([]);
    expect(m.tareas.find).not.toHaveBeenCalled();
  });

  it('para un gestor (tareas.gestionar), no filtra por asignados', async () => {
    const m = montar();

    await m.servicio.listar({}, GESTOR());

    expect(m.tareas.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
  });

  it('un administrador de plataforma cuenta como gestor', async () => {
    const m = montar();

    await m.servicio.listar({}, actor(undefined, { isPlatformAdmin: true }));

    expect(m.tareas.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
  });

  it('filtra por estado con el valor del contrato y ordena por orden ascendente', async () => {
    const m = montar();

    await m.servicio.listar({ estado: 'en_progreso' }, GESTOR());

    expect(m.tareas.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      estado: 'en_progreso',
    });
    const query = m.tareas.find.mock.results[0].value as Consulta;
    expect(query.sort).toHaveBeenCalledWith({ orden: 1 });
  });

  it('estado "todos" no filtra por estado', async () => {
    const m = montar();

    await m.servicio.listar({ estado: 'todos' }, GESTOR());

    expect(m.tareas.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
  });

  it('devuelve el contrato mapeado, con los asignados poblados', async () => {
    const m = montar();
    m.tareas.find.mockReturnValue(
      consulta([
        tareaDoc({
          asignadosIds: [{ _id: ASIGNADO, nombreCompleto: 'María Gómez' }],
        }),
      ]),
    );

    const resultado = await m.servicio.listar({}, GESTOR());

    expect(resultado).toHaveLength(1);
    expect(resultado[0].asignados).toEqual([
      { nombre: 'María Gómez', iniciales: 'MG', avatar: null },
    ]);
  });
});

describe('TareasService.completar', () => {
  it('cualquiera de varios asignados puede completar la tarea', async () => {
    const m = montar();
    const segundo = new Types.ObjectId();
    conAsignados(m, [ASIGNADO, segundo]);

    await m.servicio.completar(
      TAREA.toString(),
      actor(segundo, { nombre: 'Pedro', permissions: ['tareas.actualizar'] }),
    );

    expect(llamadaActualizar(m.tareas).filtro).toEqual({
      _id: TAREA.toString(),
      copropiedadId: COPROPIEDAD,
      asignadosIds: segundo,
    });
  });

  it('el asignado completa su propia tarea mediante una actualización atómica ($set + $push, sin reescribir el array completo)', async () => {
    const m = montar();

    await m.servicio.completar(TAREA.toString(), ASIGNADO_USER);

    // El filtro de escritura reafirma la propiedad para los no gestores
    // (a prueba de TOCTOU): es la MISMA consulta que autoriza y muta.
    const { filtro, operacion, opciones } = llamadaActualizar(m.tareas);
    expect(filtro).toEqual({
      _id: TAREA.toString(),
      copropiedadId: COPROPIEDAD,
      asignadosIds: ASIGNADO,
    });
    expect(operacion).toEqual({
      $set: { estado: 'completado', progreso: 100 },
      $push: {
        historial: expect.objectContaining({
          accion: 'Completó la tarea',
          usuario: 'María',
        }) as unknown,
      },
    });
    expect(opciones).toEqual({ new: true });
    expect(operacion.historial).toBeUndefined();
  });

  it('si la tarea fue reasignada entre el chequeo y la escritura, el filtro atómico no matchea y lanza ForbiddenException', async () => {
    const m = montar();
    m.tareas.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      m.servicio.completar(TAREA.toString(), ASIGNADO_USER),
    ).rejects.toThrow(ForbiddenException);
  });

  it('un usuario con tareas.actualizar que no es el asignado ni gestor no puede completarla', async () => {
    const m = montar();

    await expect(
      m.servicio.completar(
        TAREA.toString(),
        actor(OTRO, { permissions: ['tareas.actualizar'] }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(m.tareas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un gestor (tareas.gestionar) puede completar una tarea no asignada a él', async () => {
    const m = montar();

    await m.servicio.completar(TAREA.toString(), GESTOR());

    const { filtro, operacion } = llamadaActualizar(m.tareas);
    expect(filtro).toEqual({
      _id: TAREA.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(operacion.$set).toEqual({ estado: 'completado', progreso: 100 });
  });

  it('si la tarea pertenece a otra copropiedad, lanza NotFoundException (no 403)', async () => {
    const m = montar();
    m.tareas.findOne.mockReturnValue(consulta(null));

    await expect(
      m.servicio.completar(TAREA.toString(), ASIGNADO_USER),
    ).rejects.toThrow(NotFoundException);
    expect(m.tareas.findOneAndUpdate).not.toHaveBeenCalled();
    expect(m.tareas.findOne).toHaveBeenCalledWith({
      _id: TAREA.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });
});

describe('TareasService.agregarObservacion', () => {
  it('el asignado agrega una observación mediante $push atómico: se guarda en observaciones, el estado no cambia y queda en el historial', async () => {
    const m = montar();

    await m.servicio.agregarObservacion(
      TAREA.toString(),
      'Faltan insumos',
      ASIGNADO_USER,
    );

    const { filtro, operacion, opciones } = llamadaActualizar(m.tareas);
    expect(filtro).toEqual({
      _id: TAREA.toString(),
      copropiedadId: COPROPIEDAD,
      asignadosIds: ASIGNADO,
    });
    expect(operacion).toEqual({
      $push: {
        observaciones: expect.objectContaining({
          texto: 'Faltan insumos',
          autorId: ASIGNADO,
        }) as unknown,
        historial: expect.objectContaining({
          accion: 'Agregó una observación',
          usuario: 'María',
        }) as unknown,
      },
    });
    expect(opciones).toEqual({ new: true });
    expect(operacion.$set).toBeUndefined();
  });

  it('si la tarea fue reasignada entre el chequeo y la escritura, el filtro atómico no matchea y lanza ForbiddenException', async () => {
    const m = montar();
    m.tareas.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      m.servicio.agregarObservacion(
        TAREA.toString(),
        'Faltan insumos',
        ASIGNADO_USER,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('cada llamada empuja su propia observación de forma atómica, sin reescribir el array completo (evita perder observaciones concurrentes)', async () => {
    const m = montar();

    await m.servicio.agregarObservacion(
      TAREA.toString(),
      'Primera',
      ASIGNADO_USER,
    );
    await m.servicio.agregarObservacion(
      TAREA.toString(),
      'Segunda',
      ASIGNADO_USER,
    );

    expect(m.tareas.findOneAndUpdate).toHaveBeenCalledTimes(2);
    const primera = llamadaActualizar(m.tareas, 0).operacion.$push as {
      observaciones: unknown;
    };
    const segunda = llamadaActualizar(m.tareas, 1).operacion.$push as {
      observaciones: unknown;
    };
    expect(primera.observaciones).toEqual(
      expect.objectContaining({ texto: 'Primera' }),
    );
    expect(segunda.observaciones).toEqual(
      expect.objectContaining({ texto: 'Segunda' }),
    );
  });

  it('si el actor no tiene un accountId válido, lanza una excepción en vez de generar un autorId erróneo', async () => {
    const m = montar();

    await expect(
      m.servicio.agregarObservacion(
        TAREA.toString(),
        'Faltan insumos',
        actor(undefined, { isPlatformAdmin: true, nombre: 'Admin Plataforma' }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(m.tareas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un usuario que no es el asignado ni gestor no puede agregar observaciones', async () => {
    const m = montar();

    await expect(
      m.servicio.agregarObservacion(
        TAREA.toString(),
        'Faltan insumos',
        actor(OTRO, { permissions: ['tareas.actualizar'] }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(m.tareas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('si la tarea pertenece a otra copropiedad, lanza NotFoundException (no 403)', async () => {
    const m = montar();
    m.tareas.findOne.mockReturnValue(consulta(null));

    await expect(
      m.servicio.agregarObservacion(
        TAREA.toString(),
        'Faltan insumos',
        ASIGNADO_USER,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(m.tareas.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('TareasService.eliminar', () => {
  it('elimina por id Y copropiedad activa y devuelve el id', async () => {
    const m = montar();

    const resultado = await m.servicio.eliminar(TAREA.toString());

    expect(m.tareas.findOneAndDelete).toHaveBeenCalledWith({
      _id: TAREA.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(resultado).toEqual({ id: TAREA.toString() });
  });

  it('si no existe en la copropiedad activa, lanza NotFoundException', async () => {
    const m = montar();
    m.tareas.findOneAndDelete.mockReturnValue(consulta(null));

    await expect(m.servicio.eliminar(TAREA.toString())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('un id mal formado responde 404 sin tocar la base', async () => {
    const m = montar();

    await expect(m.servicio.eliminar('no-es-un-id')).rejects.toThrow(
      NotFoundException,
    );
    expect(m.tareas.findOneAndDelete).not.toHaveBeenCalled();
  });
});
