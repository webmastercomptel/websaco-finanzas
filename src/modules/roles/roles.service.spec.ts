import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { PERMISOS_ADMINISTRACION } from '../casl/permisos-catalogo';
import { RolesService } from './roles.service';

const COP = new Types.ObjectId();
const ROL_ID = new Types.ObjectId();

const exec = <T>(valor: T) => ({ exec: () => Promise.resolve(valor) });

const CUENTA = new Types.ObjectId();

/** A coproperty administrator holding every Administración key (not platform). */
const ADMIN_COP: IRequestUser = {
  uid: 'u',
  email: 'admin@x.co',
  accountId: CUENTA.toString(),
  permissions: PERMISOS_ADMINISTRACION.map((p) => p.id),
};

/** Staff who holds `roles.gestionar` and little else (through some role). */
const EDITOR_LIMITADO: IRequestUser = {
  uid: 'p',
  email: 'portero@x.co',
  accountId: CUENTA.toString(),
  permissions: ['roles.gestionar', 'tareas.ver'],
};

function documento(extra: Record<string, unknown> = {}) {
  return {
    _id: ROL_ID,
    copropiedadId: COP,
    codigo: 'ROL-001',
    nombre: 'Portero',
    descripcion: '',
    color: '#64748b',
    esPredeterminado: false,
    permisos: ['tareas.ver'],
    createdAt: new Date('2026-01-02T03:04:05Z'),
    ...extra,
  };
}

function crear(
  opciones: {
    encontrado?: unknown;
    roles?: unknown[];
    enUso?: number;
    /** Whether the caller holds the role through an active assignment. */
    loTiene?: boolean;
    conteos?: Array<{ _id: Types.ObjectId; n: number }>;
    /** Mongo error code the save fails with (11000 = duplicate key). */
    errorAlGuardar?: number;
  } = {},
) {
  const guardar = jest
    .fn()
    .mockImplementation((datos: Record<string, unknown>) =>
      opciones.errorAlGuardar
        ? Promise.reject(
            Object.assign(new Error('E11000 duplicate key'), {
              code: opciones.errorAlGuardar,
            }),
          )
        : Promise.resolve(documento(datos)),
    );
  const roles = {
    create: guardar,
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue(exec(opciones.roles ?? [])),
    }),
    findOneAndUpdate: jest.fn().mockReturnValue(exec(opciones.encontrado)),
    findOneAndDelete: jest.fn().mockReturnValue(exec(opciones.encontrado)),
    findOne: jest.fn().mockReturnValue(exec(opciones.encontrado)),
  };
  const asignaciones = {
    countDocuments: jest.fn().mockReturnValue(exec(opciones.enUso ?? 0)),
    exists: jest
      .fn()
      .mockReturnValue(exec(opciones.loTiene ? { _id: 'a' } : null)),
    aggregate: jest.fn().mockReturnValue(exec(opciones.conteos ?? [])),
  };
  const consecutivos = {
    findOneAndUpdate: jest.fn().mockReturnValue(exec({ valor: 7 })),
  };
  const tenant = { resolveCoPropertyId: jest.fn().mockReturnValue(COP) };
  const servicio = new RolesService(
    roles as never,
    asignaciones as never,
    consecutivos as never,
    tenant as never,
  );
  return { servicio, roles, asignaciones, consecutivos };
}

describe('RolesService.create', () => {
  it('crea el rol en la copropiedad ACTIVA con código ROL-NNN propio de esa copropiedad', async () => {
    const { servicio, roles, consecutivos } = crear();

    const rol = await servicio.create(
      {
        nombre: 'Portero',
        permisos: ['tareas.ver'],
      },
      ADMIN_COP,
    );

    expect(consecutivos.findOneAndUpdate).toHaveBeenCalledWith(
      { clave: `ROL:${COP.toString()}` },
      { $inc: { valor: 1 } },
      { upsert: true, new: true },
    );
    expect(roles.create).toHaveBeenCalledWith(
      expect.objectContaining({
        copropiedadId: COP,
        codigo: 'ROL-007',
        nombre: 'Portero',
      }),
    );
    expect(rol.usuarios).toBe(0);
  });

  it.each([
    ['una clave de finanzas', ['facturas.ver']],
    ['una clave inventada', ['inventada.ver']],
    ['un verbo que no existe en Administración', ['pqr.eliminar']],
  ])('rechaza %s dentro de un rol', async (_n, permisos) => {
    const { servicio, roles } = crear();

    await expect(
      servicio.create({ nombre: 'X', permisos }, ADMIN_COP),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('un nombre repetido en la copropiedad responde 409', async () => {
    const { servicio } = crear({ errorAlGuardar: 11000 });

    await expect(
      servicio.create({ nombre: 'Portero' }, ADMIN_COP),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('RolesService.findAll', () => {
  it('lista solo los roles de la copropiedad activa con su cantidad de usuarios', async () => {
    const { servicio, roles, asignaciones } = crear({
      roles: [documento()],
      conteos: [{ _id: ROL_ID, n: 3 }],
    });

    const lista = await servicio.findAll();

    expect(roles.find).toHaveBeenCalledWith({ copropiedadId: COP });
    expect(asignaciones.aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          $match: {
            copropiedadId: COP,
            alcance: 'copropiedad',
            estado: 'active',
          },
        },
      ]),
    );
    expect(lista).toEqual([expect.objectContaining({ usuarios: 3 })]);
  });
});

describe('RolesService.update', () => {
  it('actualiza por id Y copropiedad, y valida los permisos nuevos', async () => {
    const { servicio, roles } = crear({ encontrado: documento(), enUso: 2 });

    const rol = await servicio.update(
      ROL_ID.toString(),
      {
        nombre: 'Portero 24h',
        permisos: ['tareas.ver', 'pqr.ver'],
      },
      ADMIN_COP,
    );

    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: ROL_ID.toString(),
        copropiedadId: COP,
        permisos: ['tareas.ver'],
      },
      { nombre: 'Portero 24h', permisos: ['tareas.ver', 'pqr.ver'] },
      { new: true },
    );
    expect(rol.usuarios).toBe(2);
  });

  it('rechaza permisos de finanzas al editar', async () => {
    const { servicio, roles } = crear({ encontrado: documento() });

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['facturas.anular'] },
        ADMIN_COP,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un rol de otra copropiedad (o inexistente) es 404', async () => {
    const { servicio } = crear({ encontrado: null });

    await expect(
      servicio.update(ROL_ID.toString(), { nombre: 'x' }, ADMIN_COP),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un id mal formado es 404, sin tocar la base', async () => {
    const { servicio, roles } = crear();

    await expect(
      servicio.update('no-es-un-id', { nombre: 'x' }, ADMIN_COP),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('RolesService — mínimo privilegio (quien edita solo da lo que tiene)', () => {
  it('crear un rol con una clave que quien lo crea no tiene es 403 y no se guarda', async () => {
    const { servicio, roles } = crear();

    await expect(
      servicio.create(
        { nombre: 'Atajo', permisos: ['tareas.ver', 'usuarios.crear'] },
        EDITOR_LIMITADO,
      ),
    ).rejects.toThrow(/usuarios\.crear/);
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('escalada: quien tiene roles.gestionar NO puede meter en un rol claves que no tiene', async () => {
    const { servicio, roles } = crear({ encontrado: documento() });

    const intento = servicio.update(
      ROL_ID.toString(),
      { permisos: PERMISOS_ADMINISTRACION.map((p) => p.id) },
      EDITOR_LIMITADO,
    );

    await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('tampoco puede QUITAR de un rol una clave que no tiene', async () => {
    const { servicio, roles } = crear({
      encontrado: documento({ permisos: ['tareas.ver', 'pqr.gestionar'] }),
    });

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver'] },
        EDITOR_LIMITADO,
      ),
    ).rejects.toThrow(/pqr\.gestionar/);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('no puede cambiar los permisos de un rol que él mismo tiene asignado', async () => {
    const { servicio, roles, asignaciones } = crear({
      encontrado: documento(),
      loTiene: true,
    });

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver', 'pqr.ver'] },
        ADMIN_COP,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(asignaciones.exists).toHaveBeenCalledWith({
      accountId: CUENTA,
      copropiedadId: COP,
      roleIds: ROL_ID,
      estado: 'active',
    });
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('sí puede renombrar un rol que tiene (sin tocar permisos)', async () => {
    const { servicio, roles } = crear({
      encontrado: documento(),
      loTiene: true,
    });

    await servicio.update(
      ROL_ID.toString(),
      { nombre: 'Otro' },
      EDITOR_LIMITADO,
    );

    expect(roles.findOneAndUpdate).toHaveBeenCalled();
  });

  it('quitar y agregar claves que sí tiene está permitido', async () => {
    const { servicio, roles } = crear({
      encontrado: documento({ permisos: ['roles.gestionar'] }),
    });

    await servicio.update(
      ROL_ID.toString(),
      { permisos: ['tareas.ver'] },
      EDITOR_LIMITADO,
    );

    expect(roles.findOneAndUpdate).toHaveBeenCalled();
  });

  it('el administrador de plataforma puede armar cualquier rol del catálogo', async () => {
    const { servicio, roles } = crear({
      encontrado: documento(),
      loTiene: true,
    });
    const plataforma: IRequestUser = {
      uid: 'r',
      email: 'root@x.co',
      accountId: CUENTA.toString(),
      isPlatformAdmin: true,
      permissions: [],
    };

    await servicio.create(
      { nombre: 'Todo', permisos: ['usuarios.crear'] },
      plataforma,
    );
    await servicio.update(
      ROL_ID.toString(),
      { permisos: ['usuarios.crear'] },
      plataforma,
    );

    expect(roles.create).toHaveBeenCalled();
    expect(roles.findOneAndUpdate).toHaveBeenCalled();
  });
});

describe('RolesService.remove', () => {
  it('borra un rol sin usuarios, por id Y copropiedad', async () => {
    const { servicio, roles } = crear({ encontrado: documento(), enUso: 0 });

    await expect(servicio.remove(ROL_ID.toString())).resolves.toEqual({
      id: ROL_ID.toString(),
    });
    expect(roles.findOneAndDelete).toHaveBeenCalledWith({
      _id: ROL_ID.toString(),
      copropiedadId: COP,
    });
  });

  it('se niega si el rol todavía tiene usuarios asignados', async () => {
    const { servicio, roles } = crear({ encontrado: documento(), enUso: 1 });

    await expect(servicio.remove(ROL_ID.toString())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(roles.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('un rol de otra copropiedad es 404', async () => {
    const { servicio } = crear({ encontrado: null });

    await expect(servicio.remove(ROL_ID.toString())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RolesService.permisos', () => {
  it('ofrece el catálogo de Administración, sin ninguna clave de finanzas', () => {
    const { servicio } = crear();

    const catalogo = servicio.permisos();

    expect(catalogo.length).toBe(29);
    expect(catalogo.map((p) => p.id)).toContain('roles.gestionar');
    expect(catalogo.some((p) => p.id.startsWith('facturas.'))).toBe(false);
  });
});

describe('RolesService.update — escritura condicionada a lo revisado', () => {
  it('si otro editor cambió los permisos entre la revisión y la escritura responde 409 y no pisa nada', async () => {
    // A (without pqr.ver) reviewed {tareas.ver}; meanwhile B added pqr.ver, so
    // the conditional write no longer matches and A cannot drop B's key.
    const { servicio, roles } = crear({ encontrado: documento() });
    roles.findOneAndUpdate.mockReturnValue(exec(null));

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver', 'roles.gestionar'] },
        EDITOR_LIMITADO,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ permisos: ['tareas.ver'] }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('sin tocar permisos la escritura no lleva condición sobre ellos', async () => {
    const { servicio, roles } = crear({ encontrado: documento() });

    await servicio.update(ROL_ID.toString(), { nombre: 'x' }, ADMIN_COP);

    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ROL_ID.toString(), copropiedadId: COP },
      { nombre: 'x' },
      { new: true },
    );
  });
});
