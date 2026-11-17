import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { OrganosService } from './organos.service';

const COP = new Types.ObjectId();
const T1 = new Types.ObjectId();
const T2 = new Types.ObjectId();

const USUARIO: IRequestUser = {
  uid: 'u',
  email: 'admin@x.co',
  nombre: 'Admin',
  accountId: new Types.ObjectId().toString(),
  permissions: [],
};

/** A chainable query mock: every step returns itself, `exec` resolves. */
function cadena(valor: unknown) {
  const c: Record<string, jest.Mock> = {};
  for (const m of ['select', 'sort', 'limit', 'lean']) {
    c[m] = jest.fn().mockReturnValue(c);
  }
  c.exec = jest.fn().mockResolvedValue(valor);
  return c;
}

function montar(
  opciones: {
    filas?: unknown[];
    inmuebles?: unknown[];
    terceros?: unknown[];
    tercero?: unknown;
    existe?: boolean;
    errorAlCrear?: number;
    encontrada?: unknown;
    borrada?: unknown;
  } = {},
) {
  const integrantes = {
    find: jest.fn().mockReturnValue(cadena(opciones.filas ?? [])),
    findOne: jest.fn().mockReturnValue(cadena(opciones.encontrada ?? null)),
    exists: jest
      .fn()
      .mockReturnValue(cadena(opciones.existe ? { _id: 'x' } : null)),
    create: jest.fn().mockImplementation((datos: Record<string, unknown>[]) =>
      opciones.errorAlCrear
        ? Promise.reject(
            Object.assign(new Error('E11000'), {
              code: opciones.errorAlCrear,
            }),
          )
        : Promise.resolve([{ _id: new Types.ObjectId(), ...datos[0] }]),
    ),
    findOneAndDelete: jest
      .fn()
      .mockReturnValue(cadena(opciones.borrada ?? null)),
  };
  const inmuebles = {
    find: jest.fn().mockReturnValue(cadena(opciones.inmuebles ?? [])),
  };
  const terceros = {
    find: jest.fn().mockReturnValue(cadena(opciones.terceros ?? [])),
    findOne: jest.fn().mockReturnValue(cadena(opciones.tercero ?? null)),
  };
  const tenant = { resolveCoPropertyId: jest.fn().mockReturnValue(COP) };
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const sesion = {
    endSession: jest.fn().mockResolvedValue(undefined),
    withTransaction: async (fn: () => Promise<void>) => fn(),
  };
  const conexion = { startSession: jest.fn().mockResolvedValue(sesion) };
  const servicio = new OrganosService(
    integrantes as never,
    inmuebles as never,
    terceros as never,
    tenant as never,
    auditoria as never,
    conexion as never,
  );
  return { servicio, integrantes, inmuebles, terceros, auditoria, sesion };
}

const unidad = (codigo: string, titularId: Types.ObjectId | null = T1) => ({
  codigo,
  titularId,
  arrendatarioId: null,
});

const ANA = { _id: T1, nombre: 'Ana', emails: ['a@x.co'], estado: 'active' };

describe('OrganosService.agregar', () => {
  it('rechaza con 400 a una persona que no califica y no escribe nada', async () => {
    const { servicio, integrantes, auditoria, terceros } = montar();
    const error = await servicio
      .agregar('consejo', T1.toString(), USUARIO)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      'Esa persona no es propietaria ni arrendataria de un inmueble activo de esta copropiedad.',
    );
    expect(terceros.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ copropiedadId: COP }),
    );
    expect(integrantes.create).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('rechaza con 400 un id mal formado', async () => {
    const { servicio } = montar();
    await expect(servicio.agregar('consejo', 'zzz', USUARIO)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('responde 409 si el pre-chequeo encuentra la fila', async () => {
    const { servicio, integrantes } = montar({
      tercero: ANA,
      inmuebles: [unidad('A-101')],
      existe: true,
    });
    const error = await servicio
      .agregar('consejo', T1.toString(), USUARIO)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(
      'Esa persona ya está en el Consejo de Administración.',
    );
    expect(integrantes.exists).toHaveBeenCalledWith(
      expect.objectContaining({ copropiedadId: COP }),
    );
    expect(integrantes.create).not.toHaveBeenCalled();
  });

  it('responde 409 si la clave única salta al crear (11000)', async () => {
    const { servicio } = montar({
      tercero: ANA,
      inmuebles: [unidad('A-101')],
      errorAlCrear: 11000,
    });
    const error = await servicio
      .agregar('consejo', T1.toString(), USUARIO)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(
      'Esa persona ya está en el Consejo de Administración.',
    );
  });

  it('crea y audita con la misma sesión', async () => {
    const { servicio, integrantes, auditoria, sesion } = montar({
      tercero: ANA,
      inmuebles: [unidad('A-101')],
    });
    const miembro = await servicio.agregar(
      'comite_convivencia',
      T1.toString(),
      USUARIO,
    );
    const opcionesCrear = (
      integrantes.create.mock.calls as unknown[][]
    )[0][1] as {
      session: unknown;
    };
    expect(opcionesCrear.session).toBe(sesion);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'crear',
        entidadTipo: 'integrante-organo',
        entidadId: miembro.id,
        entidadEtiqueta: 'Comité de Convivencia: Ana',
      }),
      sesion,
    );
    expect(miembro).toMatchObject({
      organo: 'comite_convivencia',
      nombre: 'Ana',
      correos: ['a@x.co'],
      vigente: true,
      unidades: [{ codigo: 'A-101', rol: 'propietario' }],
    });
  });
});

describe('OrganosService.quitar', () => {
  it('responde 404 para un id de otra copropiedad o mal formado', async () => {
    const { servicio, integrantes } = montar();
    await expect(
      servicio.quitar(new Types.ObjectId().toString(), USUARIO),
    ).rejects.toThrow(NotFoundException);
    expect(integrantes.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ copropiedadId: COP }),
    );
    await expect(servicio.quitar('zzz', USUARIO)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('borra y audita eliminar con la misma sesión', async () => {
    const id = new Types.ObjectId();
    const fila = { _id: id, organo: 'consejo', terceroId: T1 };
    const { servicio, integrantes, auditoria, sesion } = montar({
      encontrada: fila,
      borrada: fila,
      tercero: ANA,
    });
    const r = await servicio.quitar(id.toString(), USUARIO);
    expect(r).toEqual({ id: id.toString() });
    expect(integrantes.findOneAndDelete).toHaveBeenCalledWith(
      { _id: id, copropiedadId: COP },
      { session: sesion },
    );
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'eliminar',
        entidadTipo: 'integrante-organo',
        entidadEtiqueta: 'Consejo de Administración: Ana',
      }),
      sesion,
    );
  });
});

describe('OrganosService.listar', () => {
  it('marca no vigente al miembro sin unidad activa y normaliza correos', async () => {
    const f1 = { _id: new Types.ObjectId(), organo: 'consejo', terceroId: T1 };
    const f2 = { _id: new Types.ObjectId(), organo: 'consejo', terceroId: T2 };
    const { servicio, inmuebles, terceros } = montar({
      filas: [f1, f2],
      inmuebles: [unidad('A-101', T1)],
      terceros: [
        { ...ANA, emails: [' a@x.co ', 'A@X.CO'] },
        { _id: T2, nombre: 'Beto', emails: [], estado: 'active' },
      ],
    });
    const r = await servicio.listar();
    expect(inmuebles.find).toHaveBeenCalledWith(
      expect.objectContaining({ copropiedadId: COP, estado: 'active' }),
    );
    expect(terceros.find).toHaveBeenCalledWith(
      expect.objectContaining({ copropiedadId: COP }),
    );
    expect(r.comiteConvivencia).toEqual([]);
    expect(r.consejo.map((m) => [m.nombre, m.vigente])).toEqual([
      ['Ana', true],
      ['Beto', false],
    ]);
    expect(r.consejo[0].correos).toEqual(['a@x.co']);
  });

  it('lee Persona no encontrada si el tercero ya no existe', async () => {
    const { servicio } = montar({
      filas: [{ _id: new Types.ObjectId(), organo: 'consejo', terceroId: T1 }],
      inmuebles: [unidad('A-101', T1)],
      terceros: [],
    });
    const r = await servicio.listar();
    expect(r.consejo[0]).toMatchObject({
      nombre: 'Persona no encontrada',
      vigente: false,
    });
  });
});

describe('OrganosService.candidatos', () => {
  it('no revienta con un texto de regex inválido y lo escapa', async () => {
    const { servicio, terceros, inmuebles } = montar({
      inmuebles: [unidad('A-101', T1)],
      terceros: [ANA],
    });
    const r = await servicio.candidatos('(a+');
    expect(inmuebles.find).toHaveBeenCalledWith(
      expect.objectContaining({ copropiedadId: COP }),
    );
    const filtro = (terceros.find.mock.calls as unknown[][])[0][0] as {
      copropiedadId: Types.ObjectId;
      $or: { nombre?: { $regex: string } }[];
    };
    expect(filtro.copropiedadId).toBe(COP);
    expect(filtro.$or[0].nombre?.$regex).toBe('\\(a\\+');
    expect(r).toHaveLength(1);
  });
});

describe('OrganosService.correosDeOrgano', () => {
  it('excluye a un miembro no vigente', async () => {
    const { servicio, integrantes } = montar({
      filas: [
        { _id: new Types.ObjectId(), organo: 'consejo', terceroId: T1 },
        { _id: new Types.ObjectId(), organo: 'consejo', terceroId: T2 },
      ],
      inmuebles: [unidad('A-101', T1)],
      terceros: [
        ANA,
        { _id: T2, nombre: 'Beto', emails: ['b@x.co'], estado: 'active' },
      ],
    });
    expect(await servicio.correosDeOrgano(COP, 'consejo')).toEqual(['a@x.co']);
    expect(integrantes.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      organo: 'consejo',
    });
  });

  it('devuelve [] para un órgano vacío', async () => {
    const { servicio } = montar();
    expect(await servicio.correosDeOrgano(COP, 'comite_convivencia')).toEqual(
      [],
    );
  });
});
