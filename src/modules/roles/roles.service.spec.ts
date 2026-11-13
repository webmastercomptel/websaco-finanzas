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

/** Ana: can edit roles and holds a slice of Finanzas, nothing more. */
const ANA: IRequestUser = {
  uid: 'a',
  email: 'ana@x.co',
  nombre: 'Ana Pérez',
  accountId: CUENTA.toString(),
  permissions: ['roles.gestionar', 'facturas.ver', 'facturas.crear'],
};

const PLATAFORMA: IRequestUser = {
  uid: 'r',
  email: 'root@x.co',
  accountId: CUENTA.toString(),
  isPlatformAdmin: true,
  permissions: [],
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
    /** Makes the audit write fail. */
    errorAuditoria?: boolean;
    /** Active assignments of this coproperty that carry the role. */
    titulares?: Array<{ perfil?: string; accountId: Types.ObjectId }>;
    /** Whether some holder's account is a platform admin. */
    titularDePlataforma?: boolean;
  } = {},
) {
  const guardar = jest
    .fn()
    .mockImplementation((datos: Array<Record<string, unknown>>) =>
      opciones.errorAlGuardar
        ? Promise.reject(
            Object.assign(new Error('E11000 duplicate key'), {
              code: opciones.errorAlGuardar,
            }),
          )
        : Promise.resolve([documento(datos[0])]),
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
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(exec(opciones.titulares ?? [])),
      }),
    }),
  };
  const cuentas = {
    exists: jest
      .fn()
      .mockReturnValue(
        exec(opciones.titularDePlataforma ? { _id: 'c' } : null),
      ),
  };
  const consecutivos = {
    findOneAndUpdate: jest.fn().mockReturnValue(exec({ valor: 7 })),
  };
  const tenant = { resolveCoPropertyId: jest.fn().mockReturnValue(COP) };
  const auditoria = {
    registrar: opciones.errorAuditoria
      ? jest.fn().mockRejectedValue(new Error('auditoría caída'))
      : jest.fn().mockResolvedValue(undefined),
  };
  // A transaction as far as it matters here: it records whether it was undone
  // (the callback threw), which is when Mongo would discard what it wrote.
  const sesiones: Array<{
    withTransaction: (fn: () => Promise<void>) => Promise<void>;
    endSession: jest.Mock;
    deshecha: boolean;
  }> = [];
  const conexion = {
    startSession: jest.fn(() => {
      const sesion = {
        deshecha: false,
        endSession: jest.fn().mockResolvedValue(undefined),
        withTransaction: async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (error) {
            sesion.deshecha = true;
            throw error;
          }
        },
      };
      sesiones.push(sesion);
      return Promise.resolve(sesion);
    }),
  };
  const servicio = new RolesService(
    roles as never,
    asignaciones as never,
    consecutivos as never,
    tenant as never,
    auditoria as never,
    cuentas as never,
    conexion as never,
  );
  return {
    servicio,
    roles,
    asignaciones,
    cuentas,
    consecutivos,
    auditoria,
    conexion,
    sesiones,
  };
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
      [
        expect.objectContaining({
          copropiedadId: COP,
          codigo: 'ROL-007',
          nombre: 'Portero',
        }),
      ],
      { session: expect.anything() as unknown },
    );
    expect(rol.usuarios).toBe(0);
  });

  it('S-R1.1: quien tiene una clave de Finanzas puede ponerla en un rol (201)', async () => {
    const { servicio, roles } = crear();

    const rol = await servicio.create(
      { nombre: 'Facturador', permisos: ['facturas.ver', 'facturas.crear'] },
      ANA,
    );

    expect(roles.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          permisos: ['facturas.ver', 'facturas.crear'],
        }),
      ],
      { session: expect.anything() as unknown },
    );
    expect(rol.permisos).toEqual(['facturas.ver', 'facturas.crear']);
  });

  it('S-R1.2: una clave de Finanzas que quien lo crea no tiene es 403 y no se guarda', async () => {
    const { servicio, roles, consecutivos, auditoria } = crear();

    await expect(
      servicio.create({ nombre: 'X', permisos: ['facturas.anular'] }, ANA),
    ).rejects.toThrow(/facturas\.anular/);
    await expect(
      servicio.create({ nombre: 'X', permisos: ['facturas.anular'] }, ANA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(roles.create).not.toHaveBeenCalled();
    expect(consecutivos.findOneAndUpdate).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it.each([
    ['una clave inventada', ['inventada.ver']],
    ['un verbo que no existe en Administración', ['pqr.eliminar']],
    [
      'una clave de Finanzas con un verbo que no se ofrece',
      ['inmuebles.aprobar'],
    ],
    ['el viejo gestionar de Finanzas', ['facturas.gestionar']],
  ])(
    'S-R1.3: rechaza %s dentro de un rol (400), también al administrador de plataforma',
    async (_n, permisos) => {
      for (const quien of [ADMIN_COP, PLATAFORMA]) {
        const { servicio, roles, auditoria } = crear();

        await expect(
          servicio.create({ nombre: 'X', permisos }, quien),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(roles.create).not.toHaveBeenCalled();
        expect(auditoria.registrar).not.toHaveBeenCalled();
      }
    },
  );

  it('el 400 por clave inexistente se decide antes que el 403 por clave ajena', async () => {
    const { servicio } = crear();

    await expect(
      servicio.create(
        { nombre: 'X', permisos: ['facturas.anular', 'inventada.ver'] },
        ANA,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un nombre repetido en la copropiedad responde 409 y no deja rastro en la auditoría', async () => {
    const { servicio, auditoria } = crear({ errorAlGuardar: 11000 });

    await expect(
      servicio.create({ nombre: 'Portero' }, ADMIN_COP),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('S-L2.1: el servicio no mira el contrato de la copropiedad: una clave de otro módulo se guarda igual (queda inerte)', async () => {
    const { servicio, roles } = crear();
    const conPqr: IRequestUser = { ...ANA, permissions: ['pqr.ver'] };

    await servicio.create({ nombre: 'Soporte', permisos: ['pqr.ver'] }, conPqr);

    expect(roles.create).toHaveBeenCalled();
  });

  it('D7.2: quien tiene roles.gestionar y no tiene facturas.anular no puede armar un rol con ella (403)', async () => {
    const { servicio, roles } = crear();

    await expect(
      servicio.create(
        { nombre: 'Atajo', permisos: ['tareas.ver', 'facturas.anular'] },
        EDITOR_LIMITADO,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('S-A2.1: crear un rol con dos claves escribe UNA entrada de auditoría con las claves ordenadas', async () => {
    const { servicio, auditoria } = crear();

    await servicio.create(
      { nombre: 'Facturador', permisos: ['facturas.ver', 'facturas.crear'] },
      ANA,
    );

    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      {
        actorAccountId: CUENTA.toString(),
        actorNombre: 'Ana Pérez',
        accion: 'crear',
        entidadTipo: 'rol',
        entidadId: ROL_ID.toString(),
        entidadEtiqueta: `Rol: Facturador (copropiedad ${COP.toString()})`,
        detalle: {
          agregadas: ['facturas.crear', 'facturas.ver'],
          quitadas: [],
        },
      },
      expect.anything(),
    );
  });

  it('un rol creado sin claves también queda auditado, con listas vacías', async () => {
    const { servicio, auditoria } = crear();

    await servicio.create({ nombre: 'Vacío' }, ADMIN_COP);

    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'crear',
        detalle: { agregadas: [], quitadas: [] },
      }),
      expect.anything(),
    );
  });

  it('si la auditoría falla, la petición falla (como en el resto del sistema)', async () => {
    const { servicio } = crear({ errorAuditoria: true });

    await expect(
      servicio.create({ nombre: 'X', permisos: ['tareas.ver'] }, ADMIN_COP),
    ).rejects.toThrow('auditoría caída');
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
      { new: true, session: expect.anything() as unknown },
    );
    expect(rol.usuarios).toBe(2);
  });

  it('una clave de Finanzas al editar: con la clave propia 200, sin ella 403', async () => {
    const { servicio, roles } = crear({ encontrado: documento() });

    await servicio.update(
      ROL_ID.toString(),
      { permisos: ['tareas.ver', 'facturas.ver'] },
      ANA,
    );
    expect(roles.findOneAndUpdate).toHaveBeenCalledTimes(1);

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver', 'facturas.anular'] },
        ANA,
      ),
    ).rejects.toThrow(/facturas\.anular/);
    expect(roles.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['una clave inventada', ['tareas.ver', 'inventada.ver']],
    ['pqr.eliminar', ['pqr.eliminar']],
  ])(
    'una clave NUEVA que no se ofrece (%s) es 400, también para plataforma',
    async (_n, permisos) => {
      for (const quien of [ADMIN_COP, PLATAFORMA]) {
        const { servicio, roles } = crear({ encontrado: documento() });

        await expect(
          servicio.update(ROL_ID.toString(), { permisos }, quien),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
      }
    },
  );

  it('un rol de otra copropiedad (o inexistente) es 404', async () => {
    const { servicio } = crear({ encontrado: null });

    await expect(
      servicio.update(ROL_ID.toString(), { nombre: 'x' }, ADMIN_COP),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('S-R3.3: con permisos en el cuerpo, un rol ajeno o inexistente también es 404 y no se escribe', async () => {
    const { servicio, roles, auditoria } = crear({ encontrado: null });

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver'] },
        PLATAFORMA,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(roles.findOne).toHaveBeenCalledWith({
      _id: ROL_ID.toString(),
      copropiedadId: COP,
    });
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('un id mal formado es 404, sin tocar la base', async () => {
    const { servicio, roles } = crear();

    for (const cuerpo of [{ nombre: 'x' }, { permisos: ['tareas.ver'] }]) {
      await expect(
        servicio.update('no-es-un-id', cuerpo, ADMIN_COP),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(roles.findOne).not.toHaveBeenCalled();
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

  it('S-R2.2: tampoco puede quitar una clave de Finanzas que no tiene', async () => {
    const { servicio, roles } = crear({
      encontrado: documento({ permisos: ['facturas.ver', 'facturas.anular'] }),
    });

    await expect(
      servicio.update(ROL_ID.toString(), { permisos: ['facturas.ver'] }, ANA),
    ).rejects.toThrow(/facturas\.anular/);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('S-R2.3: quitar y agregar claves que sí tiene está permitido', async () => {
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

  it('una clave que ya estaba y no se toca no se juzga, aunque quien edita no la tenga', async () => {
    const { servicio, roles } = crear({
      encontrado: documento({ permisos: ['anuncios.ver', 'tareas.ver'] }),
    });

    await servicio.update(
      ROL_ID.toString(),
      { permisos: ['anuncios.ver', 'tareas.ver', 'facturas.ver'] },
      ANA,
    );

    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { permisos: ['anuncios.ver', 'tareas.ver', 'facturas.ver'] },
      expect.anything(),
    );
  });

  it('tareas.gestionar (Administración) no habilita a dar tareas.ver: la clave es exacta', async () => {
    const { servicio, roles } = crear({
      encontrado: documento({ permisos: [] }),
    });
    const soloGestionar: IRequestUser = {
      ...EDITOR_LIMITADO,
      permissions: ['roles.gestionar', 'tareas.gestionar'],
    };

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver'] },
        soloGestionar,
      ),
    ).rejects.toThrow(/tareas\.ver/);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('S-R2.4: el administrador de plataforma puede armar cualquier rol del catálogo, Finanzas incluida', async () => {
    const { servicio, roles, asignaciones } = crear({
      encontrado: documento(),
      loTiene: true,
    });

    await servicio.create(
      { nombre: 'Todo', permisos: ['usuarios.crear', 'facturas.depurar'] },
      PLATAFORMA,
    );
    await servicio.update(
      ROL_ID.toString(),
      { permisos: ['usuarios.crear', 'facturas.anular'] },
      PLATAFORMA,
    );

    expect(roles.create).toHaveBeenCalled();
    expect(roles.findOneAndUpdate).toHaveBeenCalled();
    // Exempt from the "role you hold" rule as well.
    expect(asignaciones.exists).not.toHaveBeenCalled();
  });

  it('D7.2: tampoco puede añadir a un rol existente una clave que no tiene', async () => {
    const { servicio, roles } = crear({ encontrado: documento() });

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver', 'facturas.anular'] },
        EDITOR_LIMITADO,
      ),
    ).rejects.toThrow(/facturas\.anular/);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('RolesService.update — un rol que tienes no se reescribe', () => {
  it('S-R3.1: no puede cambiar los permisos de un rol que él mismo tiene asignado', async () => {
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

  it('ni siquiera con la misma lista de claves', async () => {
    const { servicio, roles } = crear({
      encontrado: documento(),
      loTiene: true,
    });

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver'] },
        ADMIN_COP,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
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
});

describe('RolesService.update — un rol que tiene una cuenta de la plataforma no se reescribe aquí', () => {
  const MENSAJE =
    'Este rol lo tiene una cuenta que se administra desde la plataforma: sus permisos no se pueden cambiar aquí';
  const OTRA_CUENTA = new Types.ObjectId();
  /** P: has roles.gestionar and every key he edits, holds no role R. */
  const MIEMBRO: IRequestUser = {
    uid: 'm',
    email: 'miembro@x.co',
    accountId: CUENTA.toString(),
    permissions: ['roles.gestionar', 'tareas.ver', 'pqr.ver'],
  };
  const edicion = { permisos: ['tareas.ver', 'pqr.ver'] };

  it('un titular activo administrativo: 403 con el mensaje, sin escribir ni auditar', async () => {
    const { servicio, roles, auditoria } = crear({
      encontrado: documento(),
      titulares: [{ perfil: 'administrativo', accountId: OTRA_CUENTA }],
    });

    const intento = servicio.update(ROL_ID.toString(), edicion, MIEMBRO);

    await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
    await expect(intento).rejects.toThrow(MENSAJE);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('una fila heredada sin perfil se lee como administrativo: 403', async () => {
    const { servicio, roles } = crear({
      encontrado: documento(),
      titulares: [{ accountId: OTRA_CUENTA }],
    });

    await expect(
      servicio.update(ROL_ID.toString(), edicion, MIEMBRO),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un titular personal cuya cuenta es de administrador de plataforma: 403', async () => {
    const { servicio, roles, cuentas } = crear({
      encontrado: documento(),
      titulares: [{ perfil: 'personal', accountId: OTRA_CUENTA }],
      titularDePlataforma: true,
    });

    await expect(
      servicio.update(ROL_ID.toString(), edicion, MIEMBRO),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(cuentas.exists).toHaveBeenCalledWith({
      _id: { $in: [OTRA_CUENTA] },
      esAdministradorPlataforma: true,
    });
    expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('solo titulares personal de cuentas normales: se escribe y se audita (200)', async () => {
    const { servicio, roles, auditoria } = crear({
      encontrado: documento(),
      titulares: [{ perfil: 'personal', accountId: OTRA_CUENTA }],
    });

    await servicio.update(ROL_ID.toString(), edicion, MIEMBRO);

    expect(roles.findOneAndUpdate).toHaveBeenCalled();
    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
  });

  it('mira solo a los titulares ACTIVOS de esta copropiedad', async () => {
    const { servicio, asignaciones } = crear({ encontrado: documento() });

    await servicio.update(ROL_ID.toString(), edicion, MIEMBRO);

    expect(asignaciones.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      roleIds: ROL_ID.toString(),
      estado: 'active',
    });
  });

  it('el administrador de plataforma queda exento: edita aunque lo tenga una cuenta administrativa', async () => {
    const { servicio, roles, asignaciones } = crear({
      encontrado: documento(),
      titulares: [{ perfil: 'administrativo', accountId: OTRA_CUENTA }],
      titularDePlataforma: true,
    });

    await servicio.update(ROL_ID.toString(), edicion, PLATAFORMA);

    expect(roles.findOneAndUpdate).toHaveBeenCalled();
    expect(asignaciones.find).not.toHaveBeenCalled();
  });

  it('renombrar sigue permitido aunque lo tenga una cuenta administrativa (y no consulta titulares)', async () => {
    const { servicio, roles, asignaciones } = crear({
      encontrado: documento(),
      titulares: [{ perfil: 'administrativo', accountId: OTRA_CUENTA }],
    });

    await servicio.update(ROL_ID.toString(), { nombre: 'Otro' }, MIEMBRO);

    expect(roles.findOneAndUpdate).toHaveBeenCalled();
    expect(asignaciones.find).not.toHaveBeenCalled();
  });

  it('reenviar las mismas claves no cambia el acceso de nadie: se permite', async () => {
    const { servicio, roles } = crear({
      encontrado: documento(),
      titulares: [{ perfil: 'administrativo', accountId: OTRA_CUENTA }],
    });

    await servicio.update(
      ROL_ID.toString(),
      { nombre: 'Otro', permisos: ['tareas.ver'] },
      MIEMBRO,
    );

    expect(roles.findOneAndUpdate).toHaveBeenCalled();
  });

  it('borrar conserva su regla: con titulares sigue siendo 409', async () => {
    const { servicio, roles } = crear({
      encontrado: documento(),
      enUso: 1,
      titulares: [{ perfil: 'administrativo', accountId: OTRA_CUENTA }],
    });

    await expect(
      servicio.remove(ROL_ID.toString(), MIEMBRO),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(roles.findOneAndDelete).not.toHaveBeenCalled();
  });
});

describe('RolesService.update — claves heredadas que no se ofrecen (caso a)', () => {
  const conLegado = () =>
    crear({
      encontrado: documento({ permisos: ['facturas.gestionar', 'tareas.ver'] }),
    });

  it('la clave heredada que viaja de vuelta sin cambios no se juzga: 200', async () => {
    const { servicio, roles } = conLegado();

    await servicio.update(
      ROL_ID.toString(),
      { permisos: ['facturas.gestionar', 'tareas.ver', 'facturas.ver'] },
      ANA,
    );

    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        permisos: ['facturas.gestionar', 'tareas.ver'],
      }),
      {
        permisos: ['facturas.gestionar', 'tareas.ver', 'facturas.ver'],
      },
      expect.anything(),
    );
  });

  it('omitirla también es 200: se descarta sin juicio, aunque quien edita no tenga las demás claves', async () => {
    const { servicio, roles, auditoria } = conLegado();

    // Ana does not hold tareas.ver either, but it stays: only the legacy key
    // goes, and a key that grants nothing is never judged.
    await servicio.update(ROL_ID.toString(), { permisos: ['tareas.ver'] }, ANA);

    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { permisos: ['tareas.ver'] },
      expect.anything(),
    );
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ detalle: { agregadas: [], quitadas: [] } }),
      expect.anything(),
    );
  });

  it('una clave NUEVA de ese tipo es 400 (también para plataforma)', async () => {
    for (const quien of [ANA, PLATAFORMA]) {
      const { servicio, roles } = crear({
        encontrado: documento({ permisos: ['tareas.ver'] }),
      });

      await expect(
        servicio.update(
          ROL_ID.toString(),
          { permisos: ['tareas.ver', 'facturas.gestionar'] },
          quien,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        servicio.update(
          ROL_ID.toString(),
          { permisos: ['tareas.ver', 'inmuebles.aprobar'] },
          quien,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(roles.findOneAndUpdate).not.toHaveBeenCalled();
    }
  });
});

describe('RolesService.remove', () => {
  it('borra un rol sin usuarios, por id Y copropiedad', async () => {
    const { servicio, roles } = crear({ encontrado: documento(), enUso: 0 });

    await expect(
      servicio.remove(ROL_ID.toString(), ADMIN_COP),
    ).resolves.toEqual({
      id: ROL_ID.toString(),
    });
    expect(roles.findOneAndDelete).toHaveBeenCalledWith(
      { _id: ROL_ID.toString(), copropiedadId: COP },
      { session: expect.anything() as unknown },
    );
  });

  it('se niega si el rol todavía tiene usuarios asignados, sin auditar', async () => {
    const { servicio, roles, auditoria } = crear({
      encontrado: documento(),
      enUso: 1,
    });

    await expect(
      servicio.remove(ROL_ID.toString(), ADMIN_COP),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(roles.findOneAndDelete).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('un rol de otra copropiedad es 404, sin auditar', async () => {
    const { servicio, auditoria } = crear({ encontrado: null });

    await expect(
      servicio.remove(ROL_ID.toString(), ADMIN_COP),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('un id mal formado es 404', async () => {
    const { servicio, roles } = crear();

    await expect(
      servicio.remove('no-es-un-id', ADMIN_COP),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(roles.findOne).not.toHaveBeenCalled();
  });

  it('S-R2.5: borrar un rol que nadie tiene no exige tener sus claves', async () => {
    const { servicio, roles } = crear({
      encontrado: documento({ permisos: ['facturas.anular', 'anuncios.ver'] }),
      enUso: 0,
    });

    await servicio.remove(ROL_ID.toString(), ANA);

    expect(roles.findOneAndDelete).toHaveBeenCalled();
  });

  it('S-A2.4: borrar escribe una entrada «eliminar» sobre el rol, con las claves que llevaba', async () => {
    const { servicio, auditoria } = crear({
      encontrado: documento({
        permisos: ['tareas.ver', 'facturas.anular', 'facturas.gestionar'],
      }),
      enUso: 0,
    });

    await servicio.remove(ROL_ID.toString(), ANA);

    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      {
        actorAccountId: CUENTA.toString(),
        actorNombre: 'Ana Pérez',
        accion: 'eliminar',
        entidadTipo: 'rol',
        entidadId: ROL_ID.toString(),
        entidadEtiqueta: `Rol: Portero (copropiedad ${COP.toString()})`,
        // Offered keys only, sorted: the legacy gestionar grants nothing.
        detalle: { agregadas: [], quitadas: ['facturas.anular', 'tareas.ver'] },
      },
      expect.anything(),
    );
  });

  it('si la auditoría falla, la petición falla', async () => {
    const { servicio } = crear({
      encontrado: documento(),
      enUso: 0,
      errorAuditoria: true,
    });

    await expect(servicio.remove(ROL_ID.toString(), ADMIN_COP)).rejects.toThrow(
      'auditoría caída',
    );
  });
});

describe('RolesService.permisos', () => {
  it('ofrece el catálogo de Administración, sin ninguna clave de finanzas', () => {
    const { servicio } = crear();

    const catalogo = servicio.permisos();

    expect(catalogo.length).toBe(30);
    expect(catalogo.map((p) => p.id)).toContain('roles.ver');
    expect(catalogo.map((p) => p.id)).toContain('roles.gestionar');
    expect(catalogo.some((p) => p.id.startsWith('facturas.'))).toBe(false);
  });
});

describe('RolesService.update — escritura condicionada a lo revisado', () => {
  it('si otro editor cambió los permisos entre la revisión y la escritura responde 409 y no pisa nada', async () => {
    // A (without pqr.ver) reviewed {tareas.ver}; meanwhile B added pqr.ver, so
    // the conditional write no longer matches and A cannot drop B's key.
    const { servicio, roles, auditoria } = crear({ encontrado: documento() });
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
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('S-R3.2: la condición rige también para el administrador de plataforma', async () => {
    const { servicio, roles } = crear({ encontrado: documento() });
    roles.findOneAndUpdate.mockReturnValue(exec(null));

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver', 'facturas.anular'] },
        PLATAFORMA,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ permisos: ['tareas.ver'] }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('un rol guardado sin claves se condiciona a «sin claves» (campo ausente o lista vacía)', async () => {
    const { servicio, roles } = crear({
      encontrado: documento({ permisos: [] }),
    });

    await servicio.update(
      ROL_ID.toString(),
      { permisos: ['tareas.ver'] },
      ADMIN_COP,
    );

    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: ROL_ID.toString(),
        copropiedadId: COP,
        $or: [{ permisos: { $exists: false } }, { permisos: { $size: 0 } }],
      },
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
      { new: true, session: expect.anything() as unknown },
    );
    expect(roles.findOne).not.toHaveBeenCalled();
  });
});

describe('RolesService.update — auditoría', () => {
  it('S-A2.2: renombrar escribe una entrada con las dos listas vacías', async () => {
    const { servicio, auditoria } = crear({
      encontrado: documento({ nombre: 'Otro' }),
    });

    await servicio.update(ROL_ID.toString(), { nombre: 'Otro' }, ANA);

    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      {
        actorAccountId: CUENTA.toString(),
        actorNombre: 'Ana Pérez',
        accion: 'actualizar',
        entidadTipo: 'rol',
        entidadId: ROL_ID.toString(),
        entidadEtiqueta: `Rol: Otro (copropiedad ${COP.toString()})`,
        detalle: { agregadas: [], quitadas: [] },
      },
      expect.anything(),
    );
  });

  it('cambiar claves registra lo que el tope juzgó: agregadas y quitadas ordenadas', async () => {
    const { servicio, auditoria } = crear({
      encontrado: documento({ permisos: ['tareas.ver', 'pqr.ver'] }),
    });
    const editor: IRequestUser = {
      ...ANA,
      permissions: ['tareas.ver', 'pqr.ver', 'facturas.ver', 'facturas.crear'],
    };

    await servicio.update(
      ROL_ID.toString(),
      { permisos: ['pqr.ver', 'facturas.ver', 'facturas.crear'] },
      editor,
    );

    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'actualizar',
        entidadTipo: 'rol',
        detalle: {
          agregadas: ['facturas.crear', 'facturas.ver'],
          quitadas: ['tareas.ver'],
        },
      }),
      expect.anything(),
    );
  });

  it('S-A2.3: un tope que falla no deja entrada', async () => {
    const { servicio, auditoria } = crear({ encontrado: documento() });

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver', 'facturas.anular'] },
        ANA,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('si la auditoría falla, la petición falla', async () => {
    const { servicio } = crear({
      encontrado: documento(),
      errorAuditoria: true,
    });

    await expect(
      servicio.update(ROL_ID.toString(), { nombre: 'x' }, ADMIN_COP),
    ).rejects.toThrow('auditoría caída');
  });
});

describe('RolesService — el cambio y su entrada de auditoría van en una sola transacción', () => {
  it('crear: el rol y la entrada comparten sesión; si la auditoría falla se deshace', async () => {
    const { servicio, roles, auditoria, sesiones } = crear({
      errorAuditoria: true,
    });

    await expect(
      servicio.create(
        { nombre: 'Portero', permisos: ['tareas.ver'] },
        ADMIN_COP,
      ),
    ).rejects.toThrow('auditoría caída');

    expect(sesiones).toHaveLength(1);
    expect(sesiones[0].deshecha).toBe(true);
    expect(roles.create).toHaveBeenCalledWith(expect.anything(), {
      session: sesiones[0],
    });
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.anything(),
      sesiones[0],
    );
    expect(sesiones[0].endSession).toHaveBeenCalled();
  });

  it('crear con éxito: confirma y no se deshace', async () => {
    const { servicio, sesiones } = crear();

    await servicio.create(
      { nombre: 'Portero', permisos: ['tareas.ver'] },
      ADMIN_COP,
    );

    expect(sesiones[0].deshecha).toBe(false);
  });

  it('crear: un nombre repetido sigue siendo 409 aunque ocurra dentro de la transacción', async () => {
    const { servicio, auditoria } = crear({ errorAlGuardar: 11000 });

    await expect(
      servicio.create({ nombre: 'Portero', permisos: [] }, ADMIN_COP),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('actualizar: el cambio y la entrada comparten sesión; si la auditoría falla se deshace', async () => {
    const { servicio, roles, auditoria, sesiones } = crear({
      encontrado: documento(),
      errorAuditoria: true,
    });

    await expect(
      servicio.update(ROL_ID.toString(), { nombre: 'Otro' }, ADMIN_COP),
    ).rejects.toThrow('auditoría caída');

    expect(sesiones[0].deshecha).toBe(true);
    expect(roles.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { new: true, session: sesiones[0] },
    );
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.anything(),
      sesiones[0],
    );
  });

  it('actualizar: si otro editor cambió las claves (409) no hay entrada y la petición sigue siendo 409', async () => {
    const { servicio, roles, auditoria } = crear({ encontrado: documento() });
    roles.findOneAndUpdate.mockReturnValue(exec(null));

    await expect(
      servicio.update(
        ROL_ID.toString(),
        { permisos: ['tareas.ver', 'pqr.ver'] },
        ADMIN_COP,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('actualizar: un nombre repetido sigue siendo 409 dentro de la transacción', async () => {
    const { servicio, roles } = crear({ encontrado: documento() });
    roles.findOneAndUpdate.mockImplementation(() => ({
      exec: () =>
        Promise.reject(Object.assign(new Error('dup'), { code: 11000 })),
    }));

    await expect(
      servicio.update(ROL_ID.toString(), { nombre: 'Repetido' }, ADMIN_COP),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('eliminar: el borrado y la entrada comparten sesión; si la auditoría falla se deshace y el rol no se pierde', async () => {
    const { servicio, roles, auditoria, sesiones } = crear({
      encontrado: documento(),
      errorAuditoria: true,
    });

    await expect(servicio.remove(ROL_ID.toString(), ADMIN_COP)).rejects.toThrow(
      'auditoría caída',
    );

    expect(sesiones[0].deshecha).toBe(true);
    expect(roles.findOneAndDelete).toHaveBeenCalledWith(expect.anything(), {
      session: sesiones[0],
    });
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.anything(),
      sesiones[0],
    );
  });

  it('eliminar un rol con usuarios sigue siendo 409 y no abre transacción', async () => {
    const { servicio, conexion } = crear({ encontrado: documento(), enUso: 1 });

    await expect(
      servicio.remove(ROL_ID.toString(), ADMIN_COP),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(conexion.startSession).not.toHaveBeenCalled();
  });
});
