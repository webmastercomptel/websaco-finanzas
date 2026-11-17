import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { ActualizarEquipoDto } from './dto/actualizar-equipo.dto';
import { CrearEquipoDto } from './dto/guardar-equipo.dto';
import { ListarEquiposDto } from './dto/listar-equipos.dto';
import { EquiposService } from './equipos.service';

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

const COPROPIEDAD = new Types.ObjectId();
const EQUIPO = new Types.ObjectId();

const equipoDoc = (extra: Record<string, unknown> = {}) => ({
  _id: EQUIPO,
  copropiedadId: COPROPIEDAD,
  nombre: 'Bomba de agua #2',
  tipo: 'Bomba',
  ubicacion: 'Sótano',
  marca: 'Pedrollo',
  modelo: 'X1',
  serial: 'S-1',
  fechaInstalacion: new Date('2024-03-01T00:00:00.000Z'),
  estado: 'operativo',
  notas: null,
  ...extra,
});

function montar() {
  const equipos = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) => {
      const instancia: Record<string, unknown> = { ...doc, _id: EQUIPO };
      instancia.save = jest.fn().mockResolvedValue(instancia);
      return instancia;
    }) as jest.Mock & {
    find: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    findOneAndDelete: jest.Mock;
  };
  equipos.find = jest.fn().mockReturnValue(consulta([equipoDoc()]));
  equipos.findOne = jest.fn().mockReturnValue(consulta(equipoDoc()));
  equipos.findOneAndUpdate = jest.fn().mockReturnValue(consulta(equipoDoc()));
  equipos.findOneAndDelete = jest.fn().mockReturnValue(consulta(equipoDoc()));
  const mantenimientos = {
    countDocuments: jest.fn().mockReturnValue(consulta(0)),
    find: jest.fn().mockReturnValue(consulta([])),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const servicio = new EquiposService(
    equipos as never,
    mantenimientos as never,
    tenant as never,
  );
  return { servicio, equipos, mantenimientos };
}

describe('EquiposService.listar y crear', () => {
  it('lista solo los equipos de la copropiedad activa ordenados por nombre', async () => {
    const { servicio, equipos } = montar();

    const lista = await servicio.listar({});

    expect(equipos.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
    expect(
      (equipos.find.mock.results[0].value as Consulta).sort,
    ).toHaveBeenCalledWith({ nombre: 1 });
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      id: EQUIPO.toString(),
      nombre: 'Bomba de agua #2',
      fechaInstalacion: '2024-03-01T00:00:00.000Z',
      estado: 'operativo',
      notas: null,
    });
  });

  it('filtra por estado cuando viene', async () => {
    const { servicio, equipos } = montar();

    await servicio.listar({ estado: 'dado_de_baja' });

    expect(equipos.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      estado: 'dado_de_baja',
    });
  });

  it('crea un equipo en la copropiedad activa con estado operativo por defecto', async () => {
    const { servicio, equipos } = montar();

    const creado = await servicio.crear({ nombre: 'Ascensor 1' });

    expect(equipos).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      nombre: 'Ascensor 1',
      tipo: '',
      ubicacion: '',
      marca: '',
      modelo: '',
      serial: '',
      fechaInstalacion: null,
      estado: 'operativo',
      notas: null,
    });
    expect(creado.estado).toBe('operativo');
  });

  it('convierte la fecha de instalación ISO a Date al crear', async () => {
    const { servicio, equipos } = montar();

    await servicio.crear({
      nombre: 'Planta',
      fechaInstalacion: '2023-05-10T00:00:00.000Z',
    });

    expect(equipos).toHaveBeenCalledWith(
      expect.objectContaining({
        fechaInstalacion: new Date('2023-05-10T00:00:00.000Z'),
      }),
    );
  });
});

describe('EquiposService.actualizar', () => {
  it('actualiza por id Y copropiedad, solo con lo enviado', async () => {
    const { servicio, equipos } = montar();

    await servicio.actualizar(EQUIPO.toString(), {
      nombre: 'Nuevo',
      fechaInstalacion: null,
    });

    expect(equipos.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: EQUIPO.toString(), copropiedadId: COPROPIEDAD },
      { $set: { nombre: 'Nuevo', fechaInstalacion: null } },
      { new: true },
    );
  });

  it('un cuerpo vacío no escribe: solo devuelve el equipo', async () => {
    const { servicio, equipos } = montar();

    await servicio.actualizar(EQUIPO.toString(), {});

    expect(equipos.findOneAndUpdate).not.toHaveBeenCalled();
    expect(equipos.findOne).toHaveBeenCalledWith({
      _id: EQUIPO.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('actualizar con id de otra copropiedad responde 404, y con id mal formado sin tocar la base', async () => {
    const { servicio, equipos } = montar();
    equipos.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(new Types.ObjectId().toString(), { nombre: 'X' }),
    ).rejects.toThrow(NotFoundException);
    equipos.findOneAndUpdate.mockClear();
    await expect(servicio.actualizar('mal', { nombre: 'X' })).rejects.toThrow(
      NotFoundException,
    );
    expect(equipos.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('EquiposService.buscarDelTenant', () => {
  it('busca por id Y copropiedad; un id mal formado devuelve null sin consultar', async () => {
    const { servicio, equipos } = montar();

    await servicio.buscarDelTenant(COPROPIEDAD, EQUIPO.toString());
    expect(equipos.findOne).toHaveBeenCalledWith({
      _id: EQUIPO.toString(),
      copropiedadId: COPROPIEDAD,
    });

    equipos.findOne.mockClear();
    expect(await servicio.buscarDelTenant(COPROPIEDAD, 'mal')).toBeNull();
    expect(equipos.findOne).not.toHaveBeenCalled();
  });
});

describe('EquiposService.eliminar', () => {
  it('eliminar sin mantenimientos borra y devuelve { id }', async () => {
    const { servicio, equipos, mantenimientos } = montar();

    const resultado = await servicio.eliminar(EQUIPO.toString());

    expect(resultado).toEqual({ id: EQUIPO.toString() });
    expect(mantenimientos.countDocuments).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      equipoId: EQUIPO,
    });
    expect(equipos.findOneAndDelete).toHaveBeenCalledWith({
      _id: EQUIPO.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('eliminar responde 409 si algún mantenimiento apunta al equipo, y no borra', async () => {
    const { servicio, equipos, mantenimientos } = montar();
    mantenimientos.countDocuments.mockReturnValue(consulta(2));

    const intento = servicio.eliminar(EQUIPO.toString());

    await expect(intento).rejects.toThrow(ConflictException);
    await expect(intento).rejects.toThrow(
      'Este equipo tiene mantenimientos: dalo de baja en vez de eliminarlo.',
    );
    expect(equipos.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('404 si no existe en la copropiedad activa, y con id mal formado sin tocar la base', async () => {
    const { servicio, equipos, mantenimientos } = montar();
    equipos.findOneAndDelete.mockReturnValue(consulta(null));

    await expect(servicio.eliminar(EQUIPO.toString())).rejects.toThrow(
      NotFoundException,
    );
    mantenimientos.countDocuments.mockClear();
    await expect(servicio.eliminar('mal')).rejects.toThrow(NotFoundException);
    expect(mantenimientos.countDocuments).not.toHaveBeenCalled();
  });
});

describe('DTO de equipos', () => {
  const invalidas = async <T extends object>(
    clase: new () => T,
    plano: Record<string, unknown>,
  ) => (await validate(plainToInstance(clase, plano))).map((e) => e.property);

  it('CrearEquipoDto exige nombre no vacío', async () => {
    expect(await invalidas(CrearEquipoDto, { nombre: 'Bomba' })).toEqual([]);
    expect(await invalidas(CrearEquipoDto, { nombre: '' })).toEqual(['nombre']);
    expect(await invalidas(CrearEquipoDto, {})).toEqual(['nombre']);
  });

  it('fechaInstalacion acepta ISO 8601 o null y rechaza otra cosa', async () => {
    for (const clase of [CrearEquipoDto, ActualizarEquipoDto]) {
      expect(
        await invalidas(clase, {
          nombre: 'B',
          fechaInstalacion: '2024-03-01T00:00:00.000Z',
        }),
      ).toEqual([]);
      expect(
        await invalidas(clase, { nombre: 'B', fechaInstalacion: null }),
      ).toEqual([]);
      expect(
        await invalidas(clase, { nombre: 'B', fechaInstalacion: 'ayer' }),
      ).toEqual(['fechaInstalacion']);
    }
  });

  it('estado debe ser uno de los permitidos', async () => {
    expect(
      await invalidas(CrearEquipoDto, {
        nombre: 'B',
        estado: 'fuera_de_servicio',
      }),
    ).toEqual([]);
    expect(
      await invalidas(CrearEquipoDto, { nombre: 'B', estado: 'roto' }),
    ).toEqual(['estado']);
    expect(await invalidas(ListarEquiposDto, { estado: 'roto' })).toEqual([
      'estado',
    ]);
    expect(await invalidas(ListarEquiposDto, {})).toEqual([]);
  });

  it('ActualizarEquipoDto acepta un cuerpo vacío pero no un nombre vacío', async () => {
    expect(await invalidas(ActualizarEquipoDto, {})).toEqual([]);
    expect(await invalidas(ActualizarEquipoDto, { nombre: '' })).toEqual([
      'nombre',
    ]);
  });
});

describe('EquiposService.hojaDeVida', () => {
  const mant = (
    codigo: string,
    estado: string,
    fecha: string,
    costoEstimado: number | null = null,
  ) => ({
    _id: new Types.ObjectId(),
    codigo,
    titulo: codigo,
    descripcion: '',
    tipo: 'preventivo',
    estado,
    fecha: new Date(fecha),
    proveedor: { nombre: 'Ascensores SA' },
    ubicacion: '',
    costoEstimado,
    equipoId: EQUIPO,
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-16T15:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('hoja de vida sin mantenimientos: ultimo y proximo null, costo 0, total 0', async () => {
    const { servicio } = montar();

    const hoja = await servicio.hojaDeVida(EQUIPO.toString());

    expect(hoja.equipo.id).toBe(EQUIPO.toString());
    expect(hoja.resumen).toEqual({
      ultimo: null,
      proximo: null,
      costoAcumulado: 0,
      totalMantenimientos: 0,
    });
    expect(hoja.mantenimientos).toEqual([]);
  });

  it('calcula ultimo, proximo y costo acumulado solo de completados', async () => {
    const { servicio, mantenimientos } = montar();
    const docs = [
      mant('MT-5', 'programado', '2027-01-10T00:00:00.000Z', 900),
      mant('MT-4', 'en_progreso', '2026-12-01T00:00:00.000Z'),
      mant('MT-3', 'completado', '2026-10-01T00:00:00.000Z', 300),
      mant('MT-2', 'cancelado', '2026-09-01T00:00:00.000Z', 700),
      mant('MT-1', 'completado', '2026-08-01T00:00:00.000Z'),
    ];
    mantenimientos.find.mockReturnValue(consulta(docs));

    const hoja = await servicio.hojaDeVida(EQUIPO.toString());

    expect(mantenimientos.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      equipoId: EQUIPO,
    });
    expect(hoja.resumen.ultimo).toEqual({
      id: docs[2]._id.toString(),
      codigo: 'MT-3',
      fecha: '2026-10-01T00:00:00.000Z',
    });
    expect(hoja.resumen.proximo?.codigo).toBe('MT-4');
    expect(hoja.resumen.costoAcumulado).toBe(300);
    expect(hoja.resumen.totalMantenimientos).toBe(5);
    expect(hoja.mantenimientos.map((m) => m.codigo)).toEqual([
      'MT-5',
      'MT-4',
      'MT-3',
      'MT-2',
      'MT-1',
    ]);
    expect(hoja.mantenimientos[0].equipo).toEqual({
      id: EQUIPO.toString(),
      nombre: 'Bomba de agua #2',
    });
  });

  it('un proximo con fecha pasada no cuenta como proximo', async () => {
    const { servicio, mantenimientos } = montar();
    mantenimientos.find.mockReturnValue(
      consulta([
        mant('MT-2', 'programado', '2026-11-15T00:00:00.000Z'),
        mant('MT-1', 'en_progreso', '2026-10-01T00:00:00.000Z'),
      ]),
    );

    const hoja = await servicio.hojaDeVida(EQUIPO.toString());

    expect(hoja.resumen.proximo).toBeNull();
  });

  it('un programado de hoy en Bogotá sí cuenta como proximo', async () => {
    const { servicio, mantenimientos } = montar();
    mantenimientos.find.mockReturnValue(
      consulta([mant('MT-1', 'programado', '2026-11-16T00:00:00.000Z')]),
    );

    const hoja = await servicio.hojaDeVida(EQUIPO.toString());

    expect(hoja.resumen.proximo?.codigo).toBe('MT-1');
  });

  it('equipo de otra copropiedad responde 404', async () => {
    const { servicio, equipos, mantenimientos } = montar();
    equipos.findOne.mockReturnValue(consulta(null));

    await expect(servicio.hojaDeVida(EQUIPO.toString())).rejects.toThrow(
      NotFoundException,
    );
    expect(equipos.findOne).toHaveBeenCalledWith({
      _id: EQUIPO.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(mantenimientos.find).not.toHaveBeenCalled();
  });

  it('un id mal formado responde 404', async () => {
    const { servicio } = montar();

    await expect(servicio.hojaDeVida('xyz')).rejects.toThrow(NotFoundException);
  });
});
