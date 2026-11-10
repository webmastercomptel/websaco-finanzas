import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ZonasService } from './zonas.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  sort: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.sort = jest.fn().mockReturnValue(q);
  return q;
};

type ModeloZonas = jest.Mock & {
  find: jest.Mock;
  findOneAndUpdate: jest.Mock;
  findOneAndDelete: jest.Mock;
};

const COPROPIEDAD = new Types.ObjectId();
const ZONA = new Types.ObjectId();

const zonaDoc = (extra: Record<string, unknown> = {}) => ({
  _id: ZONA,
  copropiedadId: COPROPIEDAD,
  codigo: 'ZC-001',
  nombre: 'Salón social',
  tipo: 'social',
  descripcion: '',
  capacidad: 20,
  horario: '',
  requiereReserva: true,
  costo: null,
  imagenUrl: null,
  reglas: [] as string[],
  estado: 'disponible',
  ...extra,
});

function montar() {
  const zonas = jest.fn().mockImplementation((doc: Record<string, unknown>) => {
    const instancia: Record<string, unknown> = { ...doc, _id: ZONA };
    instancia.save = jest.fn().mockResolvedValue(instancia);
    return instancia;
  }) as ModeloZonas;
  zonas.find = jest.fn().mockReturnValue(consulta([]));
  zonas.findOneAndUpdate = jest.fn().mockReturnValue(consulta(zonaDoc()));
  zonas.findOneAndDelete = jest.fn().mockReturnValue(consulta(zonaDoc()));
  const reservas = { countDocuments: jest.fn().mockResolvedValue(0) };
  const consecutivos = {
    findOneAndUpdate: jest.fn().mockReturnValue(consulta({ valor: 7 })),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const imagenes = {
    urlLectura: jest.fn((ruta: string) => Promise.resolve(`firmada:${ruta}`)),
  };
  const servicio = new ZonasService(
    zonas as never,
    reservas as never,
    consecutivos as never,
    tenant as never,
    imagenes as never,
  );
  return { servicio, zonas, reservas, consecutivos, imagenes };
}

describe('ZonasService.crear', () => {
  it('guarda la zona en la copropiedad del contexto con el siguiente código ZC-xxx', async () => {
    const { servicio, zonas, consecutivos } = montar();

    const creada = await servicio.crear({ nombre: 'Gym', tipo: 'deportiva' });

    expect(consecutivos.findOneAndUpdate).toHaveBeenCalledWith(
      { clave: 'ZC' },
      { $inc: { valor: 1 } },
      { upsert: true, new: true },
    );
    expect(zonas).toHaveBeenCalledWith(
      expect.objectContaining({
        copropiedadId: COPROPIEDAD,
        codigo: 'ZC-007',
        nombre: 'Gym',
        tipo: 'deportiva',
      }),
    );
    expect(creada.codigo).toBe('ZC-007');
  });
});

describe('ZonasService.listar', () => {
  it('filtra siempre por la copropiedad activa y ordena por código', async () => {
    const { servicio, zonas } = montar();
    const q = consulta([zonaDoc()]);
    zonas.find.mockReturnValue(q);

    const lista = await servicio.listar({});

    expect(zonas.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
    expect(q.sort).toHaveBeenCalledWith({ codigo: 1 });
    expect(lista).toHaveLength(1);
  });

  it('aplica tipo y estado, y "todos" no filtra', async () => {
    const { servicio, zonas } = montar();

    await servicio.listar({ tipo: 'deportiva', estado: 'cerrada' });
    expect(zonas.find).toHaveBeenLastCalledWith({
      copropiedadId: COPROPIEDAD,
      tipo: 'deportiva',
      estado: 'cerrada',
    });

    await servicio.listar({ tipo: 'todos', estado: 'todos' });
    expect(zonas.find).toHaveBeenLastCalledWith({ copropiedadId: COPROPIEDAD });
  });
});

describe('ZonasService.listarEspacios', () => {
  it('lista solo las zonas que requieren reserva, de la copropiedad activa', async () => {
    const { servicio, zonas } = montar();

    await servicio.listarEspacios({});

    expect(zonas.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      requiereReserva: true,
    });
  });

  it('deportes es el tipo deportiva y social es todo lo demás', async () => {
    const { servicio, zonas } = montar();

    await servicio.listarEspacios({ categoria: 'deportes' });
    expect(zonas.find).toHaveBeenLastCalledWith({
      copropiedadId: COPROPIEDAD,
      requiereReserva: true,
      tipo: 'deportiva',
    });

    await servicio.listarEspacios({ categoria: 'social' });
    expect(zonas.find).toHaveBeenLastCalledWith({
      copropiedadId: COPROPIEDAD,
      requiereReserva: true,
      tipo: { $ne: 'deportiva' },
    });

    await servicio.listarEspacios({ categoria: 'todos' });
    expect(zonas.find).toHaveBeenLastCalledWith({
      copropiedadId: COPROPIEDAD,
      requiereReserva: true,
    });
  });
});

describe('ZonasService — imagen privada servida con URL firmada', () => {
  it('listar y listarEspacios firman la ruta guardada; una URL externa o vieja pasa tal cual', async () => {
    const { servicio, zonas, imagenes } = montar();
    zonas.find.mockReturnValue(
      consulta([
        zonaDoc({ imagenRuta: 'zonas/c/z/a.png', imagenUrl: null }),
        zonaDoc({ imagenRuta: null, imagenUrl: 'https://ejemplo.com/x.png' }),
      ]),
    );

    const zonasStaff = await servicio.listar({});
    const espacios = await servicio.listarEspacios({});

    expect(zonasStaff.map((z) => z.imagen)).toEqual([
      'firmada:zonas/c/z/a.png',
      'https://ejemplo.com/x.png',
    ]);
    expect(espacios.map((e) => e.imagen)).toEqual([
      'firmada:zonas/c/z/a.png',
      'https://ejemplo.com/x.png',
    ]);
    expect(imagenes.urlLectura).toHaveBeenCalledWith('zonas/c/z/a.png');
  });

  it('poner una imagen por URL al editar descarta la ruta guardada', async () => {
    const { servicio, zonas } = montar();

    await servicio.actualizar(ZONA.toString(), {
      imagen: 'https://ejemplo.com/y.png',
    });

    expect(zonas.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      {
        $set: expect.objectContaining({
          imagenUrl: 'https://ejemplo.com/y.png',
          imagenRuta: null,
        }) as unknown,
      },
      expect.anything(),
    );
  });
});

describe('ZonasService.actualizar', () => {
  it('actualiza por id Y copropiedad y devuelve el contrato', async () => {
    const { servicio, zonas } = montar();

    const resultado = await servicio.actualizar(ZONA.toString(), {
      nombre: 'Nuevo',
    });

    expect(zonas.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ZONA.toString(), copropiedadId: COPROPIEDAD },
      { $set: { nombre: 'Nuevo' } },
      { new: true },
    );
    expect(resultado.id).toBe(ZONA.toString());
  });

  it('una zona de otra copropiedad (o inexistente) es un 404', async () => {
    const { servicio, zonas } = montar();
    zonas.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(ZONA.toString(), { nombre: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('un id mal formado es un 404 y no toca la base', async () => {
    const { servicio, zonas } = montar();

    await expect(servicio.actualizar('no-es-un-id', {})).rejects.toThrow(
      NotFoundException,
    );
    expect(zonas.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('ZonasService.eliminar', () => {
  it('borra por id Y copropiedad cuando no hay reservas vigentes', async () => {
    const { servicio, zonas } = montar();

    const resultado = await servicio.eliminar(ZONA.toString());

    expect(zonas.findOneAndDelete).toHaveBeenCalledWith({
      _id: ZONA.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(resultado).toEqual({ id: ZONA.toString() });
  });

  it('cuenta solo reservas pendientes o aprobadas que no terminaron, de esa zona y copropiedad', async () => {
    const { servicio, reservas } = montar();

    await servicio.eliminar(ZONA.toString());

    const [filtro] = reservas.countDocuments.mock.calls[0] as [
      {
        copropiedadId: Types.ObjectId;
        zonaId: Types.ObjectId;
        estado: { $in: string[] };
        fin: { $gt: Date };
      },
    ];
    expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    expect(filtro.zonaId.toString()).toBe(ZONA.toString());
    expect(filtro.estado).toEqual({ $in: ['pendiente', 'aprobada'] });
    expect(filtro.fin.$gt).toBeInstanceOf(Date);
  });

  it('"no terminaron" se mide con la hora de Bogotá: una reserva que acaba a las 21:00 escritas sigue vigente a las 16:30', async () => {
    // 16:30 in Bogotá = 21:30 UTC real; bookings store the typed hour as UTC.
    const ahoraReal = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-10T21:30:00.000Z'));
    const { servicio, reservas } = montar();

    await servicio.eliminar(ZONA.toString());
    ahoraReal.mockRestore();

    const [filtro] = reservas.countDocuments.mock.calls[0] as [
      { fin: { $gt: Date } },
    ];
    expect(filtro.fin.$gt.toISOString()).toBe('2026-09-10T16:30:00.000Z');
  });

  it('se niega con 409 si la zona tiene reservas vigentes, sin borrar nada', async () => {
    const { servicio, zonas, reservas } = montar();
    reservas.countDocuments.mockResolvedValue(2);

    await expect(servicio.eliminar(ZONA.toString())).rejects.toThrow(
      ConflictException,
    );
    expect(zonas.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('una zona de otra copropiedad (o inexistente) es un 404', async () => {
    const { servicio, zonas } = montar();
    zonas.findOneAndDelete.mockReturnValue(consulta(null));

    await expect(servicio.eliminar(ZONA.toString())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('un id mal formado es un 404 y no toca la base', async () => {
    const { servicio, zonas, reservas } = montar();

    await expect(servicio.eliminar('xx')).rejects.toThrow(NotFoundException);
    expect(reservas.countDocuments).not.toHaveBeenCalled();
    expect(zonas.findOneAndDelete).not.toHaveBeenCalled();
  });
});
