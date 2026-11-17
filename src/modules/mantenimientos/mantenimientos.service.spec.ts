import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Destinatario } from '../../common/directorio/directorio.service';
import { MantenimientosService } from './mantenimientos.service';

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

type ModeloMantenimientos = jest.Mock & {
  find: jest.Mock;
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
  findOneAndDelete: jest.Mock;
  countDocuments: jest.Mock;
};

const COPROPIEDAD = new Types.ObjectId();
const TECNICO = new Types.ObjectId();
const CUENTA_TECNICO = new Types.ObjectId();
const MANTENIMIENTO = new Types.ObjectId();
const EQUIPO = new Types.ObjectId();

const dtoBase = {
  titulo: 'Revisión de ascensores',
  tipo: 'preventivo' as const,
  fecha: '2026-09-10T08:00:00.000Z',
  proveedor: { tecnicoId: TECNICO.toString() },
};

const mantenimientoDoc = (extra: Record<string, unknown> = {}) => ({
  _id: MANTENIMIENTO,
  copropiedadId: COPROPIEDAD,
  codigo: 'MNT-001',
  titulo: 'Revisión de ascensores',
  descripcion: '',
  tipo: 'preventivo',
  estado: 'programado',
  prioridad: null,
  fecha: new Date('2026-09-10T08:00:00.000Z'),
  horario: null,
  proveedor: { nombre: 'Elevadores S.A.' },
  tecnicoId: TECNICO,
  ubicacion: '',
  notas: null,
  costoEstimado: null,
  completadoEn: null,
  equipoId: null,
  periodicidad: null,
  siguienteId: null,
  ...extra,
});

function montar() {
  const mantenimientos = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) => {
      const instancia: Record<string, unknown> = {
        ...doc,
        _id: MANTENIMIENTO,
      };
      instancia.save = jest.fn().mockResolvedValue(instancia);
      return instancia;
    }) as ModeloMantenimientos;
  mantenimientos.find = jest.fn().mockReturnValue(consulta([]));
  mantenimientos.findOne = jest
    .fn()
    .mockReturnValue(consulta(mantenimientoDoc()));
  mantenimientos.findOneAndUpdate = jest
    .fn()
    .mockReturnValue(consulta(mantenimientoDoc()));
  mantenimientos.findOneAndDelete = jest
    .fn()
    .mockReturnValue(consulta(mantenimientoDoc()));
  mantenimientos.countDocuments = jest.fn().mockReturnValue(consulta(0));

  const consecutivos = {
    findOneAndUpdate: jest.fn().mockReturnValue(consulta({ valor: 1 })),
  };
  const tecnicos = {
    findOne: jest.fn().mockReturnValue(
      consulta({
        _id: TECNICO,
        nombre: 'Elevadores S.A.',
        especialidad: 'Ascensores',
        email: 'contacto@elevadoressa.com',
      }),
    ),
  };
  const copropiedades = {
    findById: jest
      .fn()
      .mockReturnValue(consulta({ nombre: 'Torres del Parque' })),
  };
  const equipoDoc = {
    _id: EQUIPO,
    nombre: 'Ascensor 1',
    estado: 'operativo',
  };
  const equiposModelo = {
    find: jest.fn().mockReturnValue(consulta([equipoDoc])),
  };
  const equiposServicio = {
    buscarDelTenant: jest.fn().mockResolvedValue(equipoDoc),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const directorio = {
    destinatarioPorEmail: jest
      .fn<Promise<Destinatario | null>, [string, Types.ObjectId, string]>()
      .mockResolvedValue(null),
  };
  const correo = {
    enviar: jest
      .fn<Promise<boolean>, [{ para: string; asunto: string; html: string }]>()
      .mockResolvedValue(true),
  };
  const notificaciones = { crear: jest.fn().mockResolvedValue(undefined) };

  const servicio = new MantenimientosService(
    mantenimientos as never,
    consecutivos as never,
    tecnicos as never,
    copropiedades as never,
    tenant as never,
    directorio as never,
    correo as never,
    notificaciones as never,
    equiposModelo as never,
    equiposServicio as never,
  );
  return {
    servicio,
    mantenimientos,
    consecutivos,
    tecnicos,
    copropiedades,
    directorio,
    correo,
    notificaciones,
    equiposModelo,
    equiposServicio,
  };
}

describe('MantenimientosService.crear — proveedor resuelto contra el catálogo de técnicos', () => {
  it('resuelve el técnico del catálogo en la copropiedad activa, usa SU nombre y asigna el código', async () => {
    const { servicio, tecnicos } = montar();

    const creado = await servicio.crear({
      ...dtoBase,
      proveedor: {
        tecnicoId: TECNICO.toString(),
        nombre: 'Nombre del cliente',
      },
    });

    expect(tecnicos.findOne).toHaveBeenCalledWith({
      _id: TECNICO.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(creado.proveedor.nombre).toBe('Elevadores S.A.');
    expect(creado.tecnicoId).toBe(TECNICO.toString());
    expect(creado.codigo).toBe('MNT-001');
  });

  it('crea el mantenimiento con la copropiedad del contexto y estado programado por defecto', async () => {
    const { servicio, mantenimientos } = montar();

    await servicio.crear(dtoBase);

    expect(mantenimientos).toHaveBeenCalledWith(
      expect.objectContaining({
        copropiedadId: COPROPIEDAD,
        estado: 'programado',
        completadoEn: null,
        codigo: 'MNT-001',
      }),
    );
  });

  it('notifica por correo al técnico del catálogo, en texto plano (sin botón)', async () => {
    const { servicio, correo } = montar();

    await servicio.crear(dtoBase);

    expect(correo.enviar).toHaveBeenCalledWith({
      para: 'contacto@elevadoressa.com',
      asunto:
        'Mantenimiento asignado en Torres del Parque: Revisión de ascensores',
      html: expect.stringContaining('Revisión de ascensores') as string,
    });
    const { html } = correo.enviar.mock.calls[0][0];
    expect(html).not.toContain('<a href');
  });

  it('si el técnico del catálogo no tiene email, no notifica pero igual crea', async () => {
    const { servicio, tecnicos, correo, directorio, notificaciones } = montar();
    tecnicos.findOne.mockReturnValue(
      consulta({ _id: TECNICO, nombre: 'Plomería Pérez', email: '' }),
    );

    const creado = await servicio.crear(dtoBase);

    expect(creado.proveedor.nombre).toBe('Plomería Pérez');
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(directorio.destinatarioPorEmail).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
  });

  it('con un proveedor de texto libre ("otro proveedor") no hay a quién notificar', async () => {
    const { servicio, tecnicos, correo } = montar();

    const creado = await servicio.crear({
      ...dtoBase,
      proveedor: { nombre: 'Contratista Externo SAS' },
    });

    expect(tecnicos.findOne).not.toHaveBeenCalled();
    expect(creado.proveedor.nombre).toBe('Contratista Externo SAS');
    expect(creado.tecnicoId).toBeNull();
    expect(correo.enviar).not.toHaveBeenCalled();
  });

  it('rechaza con 400 si no viene ni tecnicoId ni nombre, sin crear nada', async () => {
    const { servicio, mantenimientos } = montar();

    await expect(servicio.crear({ ...dtoBase, proveedor: {} })).rejects.toThrow(
      BadRequestException,
    );
    expect(mantenimientos).not.toHaveBeenCalled();
  });

  it('rechaza con 404 si el tecnicoId no existe en la copropiedad activa', async () => {
    const { servicio, tecnicos, mantenimientos } = montar();
    tecnicos.findOne.mockReturnValue(consulta(null));

    await expect(servicio.crear(dtoBase)).rejects.toThrow(NotFoundException);
    expect(mantenimientos).not.toHaveBeenCalled();
  });

  it('un tecnicoId mal formado es 404 y ni siquiera consulta el catálogo', async () => {
    const { servicio, tecnicos } = montar();

    await expect(
      servicio.crear({ ...dtoBase, proveedor: { tecnicoId: 'no-es-un-id' } }),
    ).rejects.toThrow(NotFoundException);
    expect(tecnicos.findOne).not.toHaveBeenCalled();
  });
});

describe('MantenimientosService.crear — aviso al técnico', () => {
  const cuentaDe = (perfil: Destinatario['perfil']): Destinatario => ({
    accountId: CUENTA_TECNICO.toString(),
    email: 'contacto@elevadoressa.com',
    nombre: 'Elevadores S.A.',
    perfil,
  });

  it('crea la notificación in-app tipo mantenimiento si el email es de una cuenta de personal', async () => {
    const { servicio, directorio, notificaciones } = montar();
    directorio.destinatarioPorEmail.mockResolvedValue(cuentaDe('personal'));

    await servicio.crear(dtoBase);

    expect(directorio.destinatarioPorEmail).toHaveBeenCalledWith(
      'contacto@elevadoressa.com',
      COPROPIEDAD,
      'Mantenimiento',
    );
    expect(notificaciones.crear).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      accountId: CUENTA_TECNICO.toString(),
      tipo: 'mantenimiento',
      titulo: expect.stringContaining('Revisión de ascensores') as string,
    });
  });

  it('una cuenta solo de residente no recibe aviso in-app, pero el técnico igual recibe el correo', async () => {
    const { servicio, directorio, notificaciones, correo } = montar();
    directorio.destinatarioPorEmail.mockResolvedValue(cuentaDe('residente'));

    await servicio.crear(dtoBase);

    expect(notificaciones.crear).not.toHaveBeenCalled();
    expect(correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('si el email no corresponde a ninguna cuenta conocida no hay aviso in-app, pero sí correo', async () => {
    const { servicio, directorio, notificaciones, correo } = montar();
    directorio.destinatarioPorEmail.mockResolvedValue(null);

    await servicio.crear(dtoBase);

    expect(notificaciones.crear).not.toHaveBeenCalled();
    expect(correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('un fallo al notificar no impide que el mantenimiento se cree (el correo ya salió)', async () => {
    const { servicio, directorio, correo } = montar();
    directorio.destinatarioPorEmail.mockRejectedValue(new Error('mongo down'));

    const creado = await servicio.crear(dtoBase);

    expect(creado.titulo).toBe('Revisión de ascensores');
    expect(correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('si el envío del correo falla (false) igual crea el mantenimiento', async () => {
    const { servicio, correo } = montar();
    correo.enviar.mockResolvedValue(false);

    const creado = await servicio.crear(dtoBase);

    expect(creado.codigo).toBe('MNT-001');
  });
});

describe('MantenimientosService.listar', () => {
  it('filtra siempre por la copropiedad activa y ordena por fecha descendente', async () => {
    const { servicio, mantenimientos } = montar();
    const q = consulta([mantenimientoDoc()]);
    mantenimientos.find.mockReturnValue(q);

    const lista = await servicio.listar({});

    expect(mantenimientos.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
    });
    expect(q.sort).toHaveBeenCalledWith({ fecha: -1 });
    expect(lista).toHaveLength(1);
    expect(lista[0].id).toBe(MANTENIMIENTO.toString());
  });

  it('aplica los filtros de tipo y estado', async () => {
    const { servicio, mantenimientos } = montar();

    await servicio.listar({ tipo: 'correctivo', estado: 'en_progreso' });

    expect(mantenimientos.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      tipo: 'correctivo',
      estado: 'en_progreso',
    });
  });

  it.each(['todos', 'historial'] as const)(
    'tipo=%s no filtra por tipo',
    async (tipo) => {
      const { servicio, mantenimientos } = montar();

      await servicio.listar({ tipo, estado: 'todos' });

      expect(mantenimientos.find).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD,
      });
    },
  );
});

describe('MantenimientosService.estadisticas', () => {
  it('cuenta programados, correctivos en progreso y completados de la copropiedad, sin acotar por fecha', async () => {
    const { servicio, mantenimientos } = montar();
    mantenimientos.countDocuments
      .mockReturnValueOnce(consulta(4))
      .mockReturnValueOnce(consulta(2))
      .mockReturnValueOnce(consulta(9));

    const stats = await servicio.estadisticas();

    expect(stats).toEqual({
      programadosSemana: 4,
      enProgresoCorrective: 2,
      completadosMes: 9,
    });
    expect(mantenimientos.countDocuments.mock.calls).toEqual([
      [{ copropiedadId: COPROPIEDAD, estado: 'programado' }],
      [
        {
          copropiedadId: COPROPIEDAD,
          estado: 'en_progreso',
          tipo: 'correctivo',
        },
      ],
      [{ copropiedadId: COPROPIEDAD, estado: 'completado' }],
    ]);
  });
});

describe('MantenimientosService.actualizar', () => {
  it('actualiza por id Y copropiedad y devuelve el contrato', async () => {
    const { servicio, mantenimientos } = montar();

    const actualizado = await servicio.actualizar(MANTENIMIENTO.toString(), {
      estado: 'completado',
    });

    expect(mantenimientos.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: MANTENIMIENTO.toString(), copropiedadId: COPROPIEDAD },
      { $set: { estado: 'completado' } },
      { new: true },
    );
    expect(actualizado.id).toBe(MANTENIMIENTO.toString());
  });

  it('solo re-resuelve el proveedor si el cliente lo envió', async () => {
    const { servicio, tecnicos, mantenimientos } = montar();

    await servicio.actualizar(MANTENIMIENTO.toString(), { titulo: 'Nuevo' });
    expect(tecnicos.findOne).not.toHaveBeenCalled();

    await servicio.actualizar(MANTENIMIENTO.toString(), {
      proveedor: { tecnicoId: TECNICO.toString() },
    });
    expect(tecnicos.findOne).toHaveBeenCalledWith({
      _id: TECNICO.toString(),
      copropiedadId: COPROPIEDAD,
    });
    const [, operacion] = mantenimientos.findOneAndUpdate.mock.calls[1] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(operacion.$set).toEqual({
      proveedor: { nombre: 'Elevadores S.A.' },
      tecnicoId: TECNICO,
    });
  });

  it('responde 404 si no existe en la copropiedad activa', async () => {
    const { servicio, mantenimientos } = montar();
    mantenimientos.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(MANTENIMIENTO.toString(), { titulo: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('un id mal formado es 404 sin tocar la base', async () => {
    const { servicio, mantenimientos } = montar();

    await expect(servicio.actualizar('xyz', { titulo: 'x' })).rejects.toThrow(
      NotFoundException,
    );
    expect(mantenimientos.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('MantenimientosService.eliminar', () => {
  it('borra por id Y copropiedad', async () => {
    const { servicio, mantenimientos } = montar();

    const resultado = await servicio.eliminar(MANTENIMIENTO.toString());

    expect(mantenimientos.findOneAndDelete).toHaveBeenCalledWith({
      _id: MANTENIMIENTO.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(resultado).toEqual({ id: MANTENIMIENTO.toString() });
  });

  it('responde 404 si no existe en la copropiedad activa', async () => {
    const { servicio, mantenimientos } = montar();
    mantenimientos.findOneAndDelete.mockReturnValue(consulta(null));

    await expect(servicio.eliminar(MANTENIMIENTO.toString())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('un id mal formado es 404 sin tocar la base', async () => {
    const { servicio, mantenimientos } = montar();

    await expect(servicio.eliminar('xyz')).rejects.toThrow(NotFoundException);
    expect(mantenimientos.findOneAndDelete).not.toHaveBeenCalled();
  });
});

describe('MantenimientosService — equipo y periodicidad', () => {
  it('crear con equipoId de otra copropiedad responde 404 y no escribe', async () => {
    const { servicio, mantenimientos, equiposServicio } = montar();
    equiposServicio.buscarDelTenant.mockResolvedValue(null);

    await expect(
      servicio.crear({ ...dtoBase, equipoId: EQUIPO.toString() }),
    ).rejects.toThrow(NotFoundException);
    expect(equiposServicio.buscarDelTenant).toHaveBeenCalledWith(
      COPROPIEDAD,
      EQUIPO.toString(),
    );
    expect(mantenimientos).not.toHaveBeenCalled();
  });

  it('crear con un equipo dado de baja responde 400', async () => {
    const { servicio, mantenimientos, equiposServicio } = montar();
    equiposServicio.buscarDelTenant.mockResolvedValue({
      _id: EQUIPO,
      nombre: 'Ascensor 1',
      estado: 'dado_de_baja',
    });

    await expect(
      servicio.crear({ ...dtoBase, equipoId: EQUIPO.toString() }),
    ).rejects.toThrow(BadRequestException);
    expect(mantenimientos).not.toHaveBeenCalled();
  });

  it('crear con periodicidad y tipo correctivo responde 400', async () => {
    const { servicio, mantenimientos } = montar();

    await expect(
      servicio.crear({
        ...dtoBase,
        tipo: 'correctivo',
        periodicidad: 'mensual',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mantenimientos).not.toHaveBeenCalled();
  });

  it('crear con equipo y periodicidad válidos los guarda y el contrato trae el equipo', async () => {
    const { servicio, mantenimientos } = montar();

    const creado = await servicio.crear({
      ...dtoBase,
      equipoId: EQUIPO.toString(),
      periodicidad: 'mensual',
    });

    expect(mantenimientos).toHaveBeenCalledWith(
      expect.objectContaining({ equipoId: EQUIPO, periodicidad: 'mensual' }),
    );
    expect(creado.equipo).toEqual({
      id: EQUIPO.toString(),
      nombre: 'Ascensor 1',
    });
    expect(creado.periodicidad).toBe('mensual');
  });

  it("actualizar { periodicidad: 'mensual' } sobre un correctivo guardado responde 400", async () => {
    const { servicio, mantenimientos } = montar();
    mantenimientos.findOne.mockReturnValue(
      consulta(mantenimientoDoc({ tipo: 'correctivo' })),
    );

    await expect(
      servicio.actualizar(MANTENIMIENTO.toString(), {
        periodicidad: 'mensual',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mantenimientos.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("actualizar { tipo: 'correctivo' } sobre un preventivo mensual deja periodicidad en null", async () => {
    const { servicio, mantenimientos } = montar();
    mantenimientos.findOne.mockReturnValue(
      consulta(mantenimientoDoc({ periodicidad: 'mensual' })),
    );

    await servicio.actualizar(MANTENIMIENTO.toString(), { tipo: 'correctivo' });

    const [, operacion] = mantenimientos.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(operacion.$set).toEqual({ tipo: 'correctivo', periodicidad: null });
  });

  it('actualizar { equipoId: null, periodicidad: null } limpia ambos campos', async () => {
    const { servicio, mantenimientos, equiposServicio } = montar();

    await servicio.actualizar(MANTENIMIENTO.toString(), {
      equipoId: null,
      periodicidad: null,
    });

    const [, operacion] = mantenimientos.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(operacion.$set).toEqual({ equipoId: null, periodicidad: null });
    expect(equiposServicio.buscarDelTenant).not.toHaveBeenCalled();
  });

  it('actualizar con equipoId de otra copropiedad responde 404 sin escribir', async () => {
    const { servicio, mantenimientos, equiposServicio } = montar();
    equiposServicio.buscarDelTenant.mockResolvedValue(null);

    await expect(
      servicio.actualizar(MANTENIMIENTO.toString(), {
        equipoId: EQUIPO.toString(),
      }),
    ).rejects.toThrow(NotFoundException);
    expect(mantenimientos.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('actualizar re-enviando el mismo equipoId dado de baja junto a otro campo se acepta', async () => {
    const { servicio, mantenimientos, equiposServicio } = montar();
    equiposServicio.buscarDelTenant.mockResolvedValue({
      _id: EQUIPO,
      nombre: 'Ascensor 1',
      estado: 'dado_de_baja',
    });
    mantenimientos.findOne.mockReturnValue(
      consulta(mantenimientoDoc({ equipoId: EQUIPO })),
    );

    await servicio.actualizar(MANTENIMIENTO.toString(), {
      equipoId: EQUIPO.toString(),
      notas: 'ajuste',
    });

    const [, operacion] = mantenimientos.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(operacion.$set).toEqual({ equipoId: EQUIPO, notas: 'ajuste' });
  });

  it('actualizar cambiando el vínculo a otro equipo dado de baja responde 400', async () => {
    const { servicio, mantenimientos, equiposServicio } = montar();
    equiposServicio.buscarDelTenant.mockResolvedValue({
      _id: new Types.ObjectId(),
      nombre: 'Bomba vieja',
      estado: 'dado_de_baja',
    });
    mantenimientos.findOne.mockReturnValue(
      consulta(mantenimientoDoc({ equipoId: EQUIPO })),
    );

    await expect(
      servicio.actualizar(MANTENIMIENTO.toString(), {
        equipoId: new Types.ObjectId().toString(),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mantenimientos.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('listar con equipoId filtra por ese equipo', async () => {
    const { servicio, mantenimientos } = montar();

    await servicio.listar({ equipoId: EQUIPO.toString() });

    expect(mantenimientos.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      equipoId: EQUIPO,
    });
  });

  it('el contrato trae equipo { id, nombre } con el nombre actual del equipo (una consulta)', async () => {
    const { servicio, mantenimientos, equiposModelo } = montar();
    mantenimientos.find.mockReturnValue(
      consulta([mantenimientoDoc({ equipoId: EQUIPO })]),
    );

    const lista = await servicio.listar({});

    expect(equiposModelo.find).toHaveBeenCalledTimes(1);
    expect(equiposModelo.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
    });
    expect(lista[0].equipo).toEqual({
      id: EQUIPO.toString(),
      nombre: 'Ascensor 1',
    });
  });
});

describe('MantenimientosService.actualizar — siguiente mantenimiento al completar', () => {
  const HIJO_FECHA = '2026-10-10T08:00:00.000Z';

  /** Stored job (pre-update) and the post-update one the write returns. */
  function preparar(
    despues: Record<string, unknown> = {},
    antes: Record<string, unknown> = {},
  ) {
    const m = montar();
    m.mantenimientos.findOne.mockReturnValue(
      consulta(mantenimientoDoc({ periodicidad: 'mensual', ...antes })),
    );
    m.mantenimientos.findOneAndUpdate.mockImplementation(
      (filtro: Record<string, unknown>) =>
        consulta(
          'siguienteId' in filtro
            ? mantenimientoDoc({
                estado: 'completado',
                periodicidad: 'mensual',
              })
            : mantenimientoDoc({
                estado: 'completado',
                periodicidad: 'mensual',
                ...despues,
              }),
        ),
    );
    return m;
  }

  const completar = (m: ReturnType<typeof montar>) =>
    m.servicio.actualizar(MANTENIMIENTO.toString(), { estado: 'completado' });

  it('completar un preventivo mensual crea el siguiente programado en fecha + 1 mes con los mismos datos y codigo nuevo', async () => {
    const m = preparar({
      descripcion: 'desc',
      prioridad: 'alta',
      horario: '08:00',
      ubicacion: 'Torre A',
      costoEstimado: 100,
      equipoId: EQUIPO,
    });

    const r = await completar(m);

    expect(m.mantenimientos).toHaveBeenCalledTimes(1);
    const hijo = (m.mantenimientos.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect(hijo).toMatchObject({
      copropiedadId: COPROPIEDAD,
      codigo: 'MNT-001',
      titulo: 'Revisión de ascensores',
      descripcion: 'desc',
      tipo: 'preventivo',
      prioridad: 'alta',
      horario: '08:00',
      proveedor: { nombre: 'Elevadores S.A.' },
      tecnicoId: TECNICO,
      ubicacion: 'Torre A',
      costoEstimado: 100,
      equipoId: EQUIPO,
      periodicidad: 'mensual',
      estado: 'programado',
      notas: null,
      completadoEn: null,
      siguienteId: null,
    });
    expect(hijo.fecha).toEqual(new Date(HIJO_FECHA));
    expect(hijo._id).toBeInstanceOf(Types.ObjectId);
    // Atomicity: the claim carries the exact guard and the child's own id,
    // and it happens before the insert and before the code is consumed.
    expect(m.mantenimientos.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(m.mantenimientos.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        _id: MANTENIMIENTO,
        copropiedadId: COPROPIEDAD,
        estado: 'completado',
        siguienteId: null,
      },
      { $set: { siguienteId: hijo._id } },
    );
    const ordenReclamo =
      m.mantenimientos.findOneAndUpdate.mock.invocationCallOrder[1];
    expect(ordenReclamo).toBeLessThan(
      m.mantenimientos.mock.invocationCallOrder[0],
    );
    expect(ordenReclamo).toBeLessThan(
      m.consecutivos.findOneAndUpdate.mock.invocationCallOrder[0],
    );
    expect(r.siguiente).toEqual({
      id: MANTENIMIENTO.toString(),
      codigo: 'MNT-001',
      fecha: HIJO_FECHA,
    });
  });

  it('completar dos veces crea un solo siguiente', async () => {
    const m = preparar();
    await completar(m);
    // Second call: the guard no longer matches (siguienteId already set).
    m.mantenimientos.findOneAndUpdate.mockImplementation(
      (filtro: Record<string, unknown>) =>
        consulta(
          'siguienteId' in filtro
            ? null
            : mantenimientoDoc({
                estado: 'completado',
                periodicidad: 'mensual',
                siguienteId: new Types.ObjectId(),
              }),
        ),
    );
    const r = await completar(m);

    expect(m.mantenimientos).toHaveBeenCalledTimes(1);
    expect(r.siguiente).toBeUndefined();
  });

  it('si otra petición gana la carrera (el reclamo no coincide), no inserta, no consume código ni devuelve siguiente y completar funciona', async () => {
    const m = preparar();
    m.mantenimientos.findOneAndUpdate.mockImplementation(
      (filtro: Record<string, unknown>) =>
        consulta(
          'estado' in filtro
            ? null
            : mantenimientoDoc({
                estado: 'completado',
                periodicidad: 'mensual',
                siguienteId: null,
              }),
        ),
    );

    const r = await completar(m);

    expect(m.mantenimientos).not.toHaveBeenCalled();
    expect(m.consecutivos.findOneAndUpdate).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(r.siguiente).toBeUndefined();
    expect(r.estado).toBe('completado');
  });

  it('si el correo al técnico falla después del insert, completar funciona, devuelve siguiente y no libera el reclamo', async () => {
    const m = preparar();
    m.correo.enviar.mockRejectedValue(new Error('sendgrid caído'));

    const r = await completar(m);

    expect(m.mantenimientos).toHaveBeenCalledTimes(1);
    expect(r.siguiente).toBeDefined();
    const liberaciones = m.mantenimientos.findOneAndUpdate.mock.calls.filter(
      (c: unknown[]) =>
        JSON.stringify(c[1]) ===
        JSON.stringify({ $set: { siguienteId: null } }),
    );
    expect(liberaciones).toHaveLength(0);
  });

  it('si el insert falla, siguienteId vuelve a null y el error se propaga', async () => {
    const m = preparar();
    m.mantenimientos.mockImplementationOnce(() => ({
      save: jest.fn().mockRejectedValue(new Error('boom')),
    }));

    await expect(completar(m)).rejects.toThrow('boom');

    expect(m.mantenimientos.findOneAndUpdate).toHaveBeenLastCalledWith(
      { _id: MANTENIMIENTO, copropiedadId: COPROPIEDAD },
      { $set: { siguienteId: null } },
    );
  });

  it('sin periodicidad no crea siguiente', async () => {
    const m = preparar({ periodicidad: null });
    const r = await completar(m);
    expect(m.mantenimientos).not.toHaveBeenCalled();
    expect(r.siguiente).toBeUndefined();
  });

  it('cancelado no crea siguiente', async () => {
    const m = preparar({ estado: 'cancelado' });
    await m.servicio.actualizar(MANTENIMIENTO.toString(), {
      estado: 'cancelado',
    });
    expect(m.mantenimientos).not.toHaveBeenCalled();
  });

  it('equipo dado de baja (después del PATCH) no crea siguiente', async () => {
    const m = preparar({ equipoId: EQUIPO });
    m.equiposServicio.buscarDelTenant.mockResolvedValue({
      _id: EQUIPO,
      nombre: 'Ascensor 1',
      estado: 'dado_de_baja',
    });
    await completar(m);
    expect(m.mantenimientos).not.toHaveBeenCalled();
  });

  it('equipo fuera de servicio sí crea siguiente', async () => {
    const m = preparar({ equipoId: EQUIPO });
    m.equiposServicio.buscarDelTenant.mockResolvedValue({
      _id: EQUIPO,
      nombre: 'Ascensor 1',
      estado: 'fuera_de_servicio',
    });
    await completar(m);
    expect(m.mantenimientos).toHaveBeenCalledTimes(1);
  });

  it('un equipoId colgante cuenta como sin equipo y sí crea siguiente', async () => {
    const m = preparar({ equipoId: EQUIPO });
    m.equiposServicio.buscarDelTenant.mockResolvedValue(null);
    await completar(m);
    expect(m.mantenimientos).toHaveBeenCalledTimes(1);
  });

  it('con técnico existente, el siguiente envía el correo de asignación', async () => {
    const m = preparar();
    await completar(m);
    expect(m.tecnicos.findOne).toHaveBeenCalledWith({
      _id: TECNICO,
      copropiedadId: COPROPIEDAD,
    });
    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
    expect(m.correo.enviar.mock.calls[0][0].para).toBe(
      'contacto@elevadoressa.com',
    );
  });

  it('con técnico borrado, el siguiente guarda el nombre, tecnicoId null y no envía correo, y completar no falla', async () => {
    const m = preparar();
    m.tecnicos.findOne.mockReturnValue(consulta(null));

    const r = await completar(m);

    const hijo = (m.mantenimientos.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect(hijo.proveedor).toEqual({ nombre: 'Elevadores S.A.' });
    expect(hijo.tecnicoId).toBeNull();
    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(r.siguiente).toBeDefined();
  });

  it('una fecha calculada en el pasado se usa tal cual', async () => {
    const m = preparar({ fecha: new Date('2020-01-31T00:00:00.000Z') });
    const r = await completar(m);
    expect(r.siguiente?.fecha).toBe('2020-02-29T00:00:00.000Z');
  });
});
