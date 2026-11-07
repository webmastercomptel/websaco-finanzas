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
  findOneAndUpdate: jest.Mock;
  findOneAndDelete: jest.Mock;
  countDocuments: jest.Mock;
};

const COPROPIEDAD = new Types.ObjectId();
const TECNICO = new Types.ObjectId();
const CUENTA_TECNICO = new Types.ObjectId();
const MANTENIMIENTO = new Types.ObjectId();

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
