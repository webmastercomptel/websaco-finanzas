import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { ActualizarTecnicoDto } from './dto/actualizar-tecnico.dto';
import { CrearTecnicoDto } from './dto/guardar-tecnico.dto';
import { TecnicosService } from './tecnicos.service';

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
const TECNICO = new Types.ObjectId();

const tecnicoDoc = (extra: Record<string, unknown> = {}) => ({
  _id: TECNICO,
  copropiedadId: COPROPIEDAD,
  nombre: 'Juan Técnico',
  especialidad: 'Plomería',
  email: 'juan@example.com',
  ...extra,
});

function montar() {
  const tecnicos = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) => {
      const instancia: Record<string, unknown> = { ...doc, _id: TECNICO };
      instancia.save = jest.fn().mockResolvedValue(instancia);
      return instancia;
    }) as jest.Mock & {
    find: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    findOneAndDelete: jest.Mock;
  };
  tecnicos.find = jest.fn().mockReturnValue(consulta([tecnicoDoc()]));
  tecnicos.findOne = jest.fn().mockReturnValue(consulta(tecnicoDoc()));
  tecnicos.findOneAndUpdate = jest.fn().mockReturnValue(consulta(tecnicoDoc()));
  tecnicos.findOneAndDelete = jest.fn().mockReturnValue(consulta(tecnicoDoc()));
  const pqrs = {
    countDocuments: jest.fn().mockReturnValue(consulta(0)),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const servicio = new TecnicosService(
    tecnicos as never,
    pqrs as never,
    tenant as never,
  );
  return { servicio, tecnicos, pqrs };
}

describe('TecnicosService.listar y crear', () => {
  it('lista solo los de la copropiedad activa, por nombre', async () => {
    const { servicio, tecnicos } = montar();

    const lista = await servicio.listar();

    expect(tecnicos.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
    expect(
      (tecnicos.find.mock.results[0].value as Consulta).sort,
    ).toHaveBeenCalledWith({ nombre: 1 });
    expect(lista).toEqual([
      {
        id: TECNICO.toString(),
        nombre: 'Juan Técnico',
        especialidad: 'Plomería',
        email: 'juan@example.com',
      },
    ]);
  });

  it('crea en la copropiedad del contexto, con vacíos por defecto', async () => {
    const { servicio, tecnicos } = montar();

    await servicio.crear({ nombre: 'Luis' });

    expect(tecnicos).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      nombre: 'Luis',
      especialidad: '',
      email: '',
    });
  });
});

describe('TecnicosService.actualizar', () => {
  it('actualiza por id Y copropiedad, solo con lo enviado', async () => {
    const { servicio, tecnicos } = montar();

    await servicio.actualizar(TECNICO.toString(), { nombre: 'Nuevo' });

    expect(tecnicos.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: TECNICO.toString(), copropiedadId: COPROPIEDAD },
      { $set: { nombre: 'Nuevo' } },
      { new: true },
    );
  });

  it('un cuerpo vacío no escribe: solo devuelve el técnico', async () => {
    const { servicio, tecnicos } = montar();

    await servicio.actualizar(TECNICO.toString(), {});

    expect(tecnicos.findOneAndUpdate).not.toHaveBeenCalled();
    expect(tecnicos.findOne).toHaveBeenCalledWith({
      _id: TECNICO.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('404 si el técnico no existe en la copropiedad activa, y con id mal formado sin tocar la base', async () => {
    const { servicio, tecnicos } = montar();
    tecnicos.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(new Types.ObjectId().toString(), { nombre: 'X' }),
    ).rejects.toThrow(NotFoundException);
    tecnicos.findOneAndUpdate.mockClear();
    await expect(servicio.actualizar('mal', { nombre: 'X' })).rejects.toThrow(
      NotFoundException,
    );
    expect(tecnicos.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('TecnicosService.eliminar', () => {
  it('elimina por id Y copropiedad un técnico sin PQR activas', async () => {
    const { servicio, tecnicos, pqrs } = montar();

    const resultado = await servicio.eliminar(TECNICO.toString());

    expect(resultado).toEqual({ id: TECNICO.toString() });
    expect(pqrs.countDocuments).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      tecnicoId: TECNICO,
      estado: { $nin: ['resuelto', 'cerrado'] },
    });
    expect(tecnicos.findOneAndDelete).toHaveBeenCalledWith({
      _id: TECNICO.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('409 si todavía tiene PQR sin resolver ni cerrar, y no borra', async () => {
    const { servicio, tecnicos, pqrs } = montar();
    pqrs.countDocuments.mockReturnValue(consulta(1));

    await expect(servicio.eliminar(TECNICO.toString())).rejects.toThrow(
      ConflictException,
    );
    expect(tecnicos.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('404 si no existe en la copropiedad activa, y con id mal formado sin tocar la base', async () => {
    const { servicio, tecnicos, pqrs } = montar();
    tecnicos.findOneAndDelete.mockReturnValue(consulta(null));

    await expect(servicio.eliminar(TECNICO.toString())).rejects.toThrow(
      NotFoundException,
    );
    pqrs.countDocuments.mockClear();
    await expect(servicio.eliminar('mal')).rejects.toThrow(NotFoundException);
    expect(pqrs.countDocuments).not.toHaveBeenCalled();
  });
});

describe('DTO de técnicos', () => {
  const invalidas = async <T extends object>(
    clase: new () => T,
    plano: Record<string, unknown>,
  ) => (await validate(plainToInstance(clase, plano))).map((e) => e.property);

  it('CrearTecnicoDto exige nombre y valida el correo si viene', async () => {
    expect(await invalidas(CrearTecnicoDto, { nombre: 'Luis' })).toEqual([]);
    expect(
      await invalidas(CrearTecnicoDto, {
        nombre: 'Luis',
        especialidad: 'Gas',
        email: 'luis@example.com',
      }),
    ).toEqual([]);
    expect(await invalidas(CrearTecnicoDto, { nombre: '' })).toEqual([
      'nombre',
    ]);
    expect(
      await invalidas(CrearTecnicoDto, {
        nombre: 'Luis',
        email: 'no-es-correo',
      }),
    ).toEqual(['email']);
  });

  it('ActualizarTecnicoDto acepta un cuerpo vacío pero no un nombre vacío', async () => {
    expect(await invalidas(ActualizarTecnicoDto, {})).toEqual([]);
    expect(await invalidas(ActualizarTecnicoDto, { nombre: '' })).toEqual([
      'nombre',
    ]);
  });
});
