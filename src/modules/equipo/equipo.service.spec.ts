import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { InvitacionAccesoService } from '../acceso-residentes/invitacion-acceso.service';
import {
  moduloDePermiso,
  PERMISOS_ADMINISTRACION,
  PERMISOS_FINANZAS,
} from '../casl/permisos-catalogo';
import { EquipoService } from './equipo.service';

const COP = new Types.ObjectId();
const OTRA_COP = new Types.ObjectId();

interface AsignacionFake {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  perfil: 'administrativo' | 'personal';
  alcance: 'copropiedad' | 'entidad';
  copropiedadId: Types.ObjectId | null;
  entidadId: Types.ObjectId | null;
  permisos: string[];
  roleIds: Types.ObjectId[];
  estado: 'active' | 'inactive';
}
interface CuentaFake {
  _id: Types.ObjectId;
  firebaseUid: string;
  email: string;
  nombreCompleto: string;
  esAdministradorPlataforma: boolean;
  estado: 'active' | 'inactive';
}
interface RolFake {
  _id: Types.ObjectId;
  copropiedadId: Types.ObjectId;
  nombre: string;
  permisos: string[];
}

const cuenta = (over: Partial<CuentaFake> = {}): CuentaFake => ({
  _id: new Types.ObjectId(),
  firebaseUid: 'uid-x',
  email: 'persona@correo.co',
  nombreCompleto: 'Persona Uno',
  esAdministradorPlataforma: false,
  estado: 'active',
  ...over,
});
const asignacion = (
  accountId: Types.ObjectId,
  over: Partial<AsignacionFake> = {},
): AsignacionFake => ({
  _id: new Types.ObjectId(),
  accountId,
  perfil: 'personal',
  alcance: 'copropiedad',
  copropiedadId: COP,
  entidadId: null,
  permisos: ['tareas.ver'],
  roleIds: [],
  estado: 'active',
  ...over,
});
const rol = (over: Partial<RolFake> = {}): RolFake => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  nombre: 'Portero',
  permisos: ['tareas.ver'],
  ...over,
});

const mismo = (a: unknown, b: unknown) => String(a) === String(b);
const coincide = (
  item: Record<string, unknown>,
  filtro: Record<string, unknown>,
): boolean =>
  Object.entries(filtro).every(([k, cond]) => {
    if (k === '$and') {
      return (cond as Array<Record<string, unknown>>).every((f) =>
        coincide(item, f),
      );
    }
    if (k === '$or') {
      return (cond as Array<Record<string, unknown>>).some((f) =>
        coincide(item, f),
      );
    }
    const v = item[k];
    if (cond === null) return v == null;
    if (cond instanceof Types.ObjectId) return mismo(v, cond);
    // Mongo's array equality: same length, same elements, same order.
    if (Array.isArray(cond)) {
      return (
        Array.isArray(v) &&
        v.length === cond.length &&
        cond.every((x, i) => mismo(x, v[i]))
      );
    }
    if (cond && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('$in' in c) return (c.$in as unknown[]).some((x) => mismo(x, v));
      if ('$ne' in c) return !mismo(v, c.$ne);
      if ('$exists' in c) return (v !== undefined) === c.$exists;
      if ('$size' in c) return Array.isArray(v) && v.length === c.$size;
    }
    return v === cond;
  });

/**
 * What a query hands back: a copy, never the stored object. The service reads a
 * row, decides, and writes later; if the "database" returned its own object, a
 * change made in between would silently rewrite what the service already read
 * and no race could ever be simulated.
 */
const copia = <T extends { permisos?: string[]; roleIds?: unknown[] }>(
  item: T,
): T => ({
  ...item,
  ...(item.permisos ? { permisos: [...item.permisos] } : {}),
  ...(item.roleIds ? { roleIds: [...item.roleIds] } : {}),
});

const consulta = <T>(resultado: () => T) => {
  const q = {
    select: () => q,
    sort: () => q,
    lean: () => q,
    exec: () => Promise.resolve(resultado()),
  };
  return q;
};

const CLAVES = PERMISOS_ADMINISTRACION.map((p) => p.id);
/** Every key a grid can draw (Finanzas catalog plus Administración catalog): 86. */
const OFRECIDAS = [...PERMISOS_FINANZAS, ...CLAVES];

/** The audit `detalle` the cap produced. */
const detalle = (agregadas: string[], quitadas: string[]) => ({
  agregadas,
  quitadas,
});

/** Caller: holds the keys given, is not a platform admin unless said so. */
const actor = (
  permisos: string[],
  over: Partial<IRequestUser> = {},
): IRequestUser => ({
  uid: 'uid-actor',
  email: 'admin@edificio.co',
  accountId: new Types.ObjectId().toString(),
  nombre: 'Admin Edificio',
  permissions: permisos,
  ...over,
});

interface Opciones {
  cuentas?: CuentaFake[];
  asignaciones?: AsignacionFake[];
  roles?: RolFake[];
  correoConfigurado?: boolean;
  enlace?: string | null;
  /** The link stub withholds the link from an account with Finanzas keys, as the real service does. */
  enlaceSegunAcceso?: boolean;
  firebaseConoce?: string[];
}

function montar(opciones: Opciones = {}) {
  const storeCuentas = opciones.cuentas ?? [];
  const storeAsig = opciones.asignaciones ?? [];
  const storeRoles = opciones.roles ?? [];
  const identidades = new Set(opciones.firebaseConoce ?? []);
  const passwords: string[] = [];
  const enviados: Array<{ para: string; asunto: string; html: string }> = [];

  const asignacionesModel = {
    find: jest.fn((f: Record<string, unknown>) =>
      consulta(() =>
        storeAsig.filter((a) => coincide(a as never, f)).map(copia),
      ),
    ),
    findOne: jest.fn((f: Record<string, unknown>) =>
      consulta(() => {
        const a = storeAsig.find((x) => coincide(x as never, f));
        return a ? copia(a) : null;
      }),
    ),
    create: jest.fn(
      (
        docs: Array<Omit<AsignacionFake, '_id'>>,
        _opciones?: { session?: unknown },
      ) => {
        const [doc] = docs;
        if (
          storeAsig.some(
            (a) =>
              mismo(a.accountId, doc.accountId) &&
              mismo(a.copropiedadId, doc.copropiedadId),
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('dup'), { code: 11000 }),
          );
        }
        const nueva = { _id: new Types.ObjectId(), ...doc };
        storeAsig.push(nueva);
        return Promise.resolve([nueva]);
      },
    ),
    updateOne: jest.fn(
      (
        f: Record<string, unknown>,
        u: { $set: Record<string, unknown> },
        _opciones?: { session?: unknown },
      ) =>
        consulta(() => {
          const a = storeAsig.find((x) => coincide(x as never, f));
          if (!a) return { matchedCount: 0 };
          Object.assign(a, u.$set);
          return { matchedCount: 1 };
        }),
    ),
    exists: jest.fn((f: Record<string, unknown>) =>
      consulta(() => storeAsig.find((a) => coincide(a as never, f)) ?? null),
    ),
  };
  const cuentasModel = {
    findOne: jest.fn((f: { email: string }) =>
      consulta(() => storeCuentas.find((c) => c.email === f.email) ?? null),
    ),
    findById: jest.fn((id: Types.ObjectId) =>
      consulta(() => storeCuentas.find((c) => mismo(c._id, id)) ?? null),
    ),
    find: jest.fn((f: { _id: { $in: Types.ObjectId[] } }) =>
      consulta(() =>
        storeCuentas.filter((c) => f._id.$in.some((i) => mismo(i, c._id))),
      ),
    ),
    create: jest.fn((doc: Omit<CuentaFake, '_id'>) => {
      const nueva = { _id: new Types.ObjectId(), ...doc };
      storeCuentas.push(nueva);
      return Promise.resolve(nueva);
    }),
    updateOne: jest.fn(
      (
        f: { _id: Types.ObjectId },
        u: { $set: Record<string, unknown> },
        _opciones?: { session?: unknown },
      ) =>
        consulta(() => {
          const c = storeCuentas.find((x) => mismo(x._id, f._id));
          if (c) Object.assign(c, u.$set);
          return { matchedCount: c ? 1 : 0 };
        }),
    ),
    deleteOne: jest.fn(),
  };
  const rolesModel = {
    find: jest.fn(
      (f: { _id: { $in: Types.ObjectId[] }; copropiedadId: Types.ObjectId }) =>
        consulta(() =>
          storeRoles.filter(
            (r) =>
              f._id.$in.some((i) => mismo(i, r._id)) &&
              mismo(r.copropiedadId, f.copropiedadId),
          ),
        ),
    ),
  };
  const firebase = {
    crear: jest.fn((d: { email: string; password: string; nombre: string }) => {
      passwords.push(d.password);
      if (identidades.has(d.email)) {
        return Promise.reject(
          new ConflictException(
            'Ya existe una cuenta de Firebase con ese correo.',
          ),
        );
      }
      identidades.add(d.email);
      return Promise.resolve({ uid: `uid-${d.email}` });
    }),
    establecerHabilitado: jest.fn(),
    actualizarPassword: jest.fn(),
  };
  const correo = {
    estaConfigurado: jest.fn(() => opciones.correoConfigurado ?? true),
    enviar: jest.fn((m: { para: string; asunto: string; html: string }) => {
      enviados.push(m);
      return Promise.resolve(true);
    }),
  };
  const enlaces = {
    construir: jest.fn((accountId: string) => {
      // Mirrors the rule of EnlaceAccesoService (pinned in its own spec): no
      // sign-in link for an account holding any Finanzas key. It reads the
      // store AT CALL TIME, so it also proves the assignment is written before
      // the invitation is prepared.
      if (opciones.enlaceSegunAcceso) {
        const claves = storeAsig
          .filter((a) => a.estado === 'active' && mismo(a.accountId, accountId))
          .flatMap((a) => [
            ...a.permisos,
            ...a.roleIds.flatMap(
              (id) => storeRoles.find((r) => mismo(r._id, id))?.permisos ?? [],
            ),
          ]);
        if (claves.some((k) => moduloDePermiso(k) === 'finanzas')) {
          return Promise.resolve(null);
        }
      }
      return Promise.resolve(
        opciones.enlace === undefined
          ? 'https://app.co/auth/enlace?token=t'
          : opciones.enlace,
      );
    }),
  };
  const copropiedades = {
    findById: jest.fn(() => consulta(() => ({ nombre: 'Edificio Central' }))),
  };
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const tenant = { resolveCoPropertyId: jest.fn(() => COP) };
  // A transaction that behaves like Mongo's where it matters here: what the
  // callback wrote is undone when it throws. Rows are mutated in place, so the
  // undo restores each stored object instead of swapping the arrays.
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
          const foto = [storeAsig, storeCuentas].map((lista) => ({
            lista,
            filas: (lista as unknown as Array<Record<string, unknown>>).map(
              (fila) => ({
                fila,
                antes: copia(fila),
              }),
            ),
          }));
          try {
            await fn();
          } catch (error) {
            sesion.deshecha = true;
            for (const { lista, filas } of foto) {
              lista.length = 0;
              for (const { fila, antes } of filas) {
                Object.assign(fila, antes);
                (lista as unknown[]).push(fila);
              }
            }
            throw error;
          }
        },
      };
      sesiones.push(sesion);
      return Promise.resolve(sesion);
    }),
  };
  const invitaciones = new InvitacionAccesoService(
    correo as never,
    enlaces as never,
    copropiedades as never,
  );
  const servicio = new EquipoService(
    asignacionesModel as never,
    cuentasModel as never,
    rolesModel as never,
    firebase as never,
    tenant as never,
    invitaciones,
    auditoria as never,
    conexion as never,
  );
  return {
    servicio,
    conexion,
    sesiones,
    asignacionesModel,
    cuentasModel,
    rolesModel,
    firebase,
    correo,
    enlaces,
    auditoria,
    storeAsig,
    storeCuentas,
    identidades,
    passwords,
    enviados,
  };
}

/**
 * Runs `efecto` once, after the service has read the member and before it
 * writes: the account lookup sits exactly between the two in `actualizar` and
 * `desactivar`, so a second editor "arriving in between" is simulated there.
 */
const entreLecturaYEscritura = (
  m: ReturnType<typeof montar>,
  efecto: () => void,
): void => {
  const original = m.cuentasModel.findById.getMockImplementation()!;
  m.cuentasModel.findById.mockImplementationOnce((id: Types.ObjectId) => {
    efecto();
    return original(id);
  });
};

const CREAR = { nombre: 'Nuevo Portero', email: 'nuevo@correo.co' };

describe('EquipoService.crear — lo que sí hace', () => {
  it('crea identidad, cuenta y asignación personal de ESTA copropiedad, audita e invita', async () => {
    const m = montar();
    const caller = actor(['usuarios.crear', 'tareas.ver']);

    const r = await m.servicio.crear(
      { ...CREAR, permisos: ['tareas.ver'] },
      caller,
    );

    expect(m.firebase.crear).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'nuevo@correo.co',
        nombre: 'Nuevo Portero',
      }),
    );
    expect(
      m.firebase.crear.mock.calls[0][0].password.length,
    ).toBeGreaterThanOrEqual(32);
    expect(m.cuentasModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'nuevo@correo.co',
        esAdministradorPlataforma: false,
        estado: 'active',
      }),
    );
    expect(m.asignacionesModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          perfil: 'personal',
          alcance: 'copropiedad',
          entidadId: null,
          estado: 'active',
          permisos: ['tareas.ver'],
        }),
      ],
      { session: m.sesiones[0] },
    );
    expect(
      String(m.asignacionesModel.create.mock.calls[0][0][0].copropiedadId),
    ).toBe(COP.toString());
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAccountId: caller.accountId,
        accion: 'crear',
        entidadTipo: 'usuario',
      }),
      expect.anything(),
    );
    expect(r).toMatchObject({
      cuentaExistente: false,
      invitacionEnviada: true,
      enlaceIncluido: true,
      miembro: {
        email: 'nuevo@correo.co',
        perfil: 'personal',
        estado: 'activo',
        editable: true,
      },
    });
  });

  it('ninguna contraseña aparece en el correo, en la respuesta ni en la auditoría', async () => {
    const m = montar();
    const r = await m.servicio.crear(
      { ...CREAR, permisos: ['tareas.ver'] },
      actor(['tareas.ver']),
    );

    const [password] = m.passwords;
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0].html).not.toContain(password);
    expect(JSON.stringify(r)).not.toContain(password);
    expect(JSON.stringify(m.auditoria.registrar.mock.calls)).not.toContain(
      password,
    );
    expect(m.enlaces.construir).toHaveBeenCalledWith(
      expect.any(String),
      COP.toString(),
      '/',
    );
  });

  it('adjunta roles de esta copropiedad cuyas claves el creador también tiene', async () => {
    const r1 = rol({ permisos: ['tareas.ver', 'anuncios.ver'] });
    const m = montar({ roles: [r1] });

    const r = await m.servicio.crear(
      { ...CREAR, rolIds: [r1._id.toString()] },
      actor(['tareas.ver', 'anuncios.ver']),
    );

    expect(m.asignacionesModel.create.mock.calls[0][0][0].roleIds).toEqual([
      r1._id,
    ]);
    expect(r.miembro.roles).toEqual([
      { id: r1._id.toString(), nombre: 'Portero' },
    ]);
    // The role lookup is bounded to the active coproperty.
    expect(String(m.rolesModel.find.mock.calls[0][0].copropiedadId)).toBe(
      COP.toString(),
    );
  });

  it('sin correo configurado crea el acceso y lo declara', async () => {
    const m = montar({ correoConfigurado: false });
    const r = await m.servicio.crear(
      { ...CREAR, permisos: ['tareas.ver'] },
      actor(['tareas.ver']),
    );

    expect(r.invitacionEnviada).toBe(false);
    expect(r.enlaceIncluido).toBe(false);
    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(m.storeAsig).toHaveLength(1);
  });

  it('sin enlace envía la invitación sin botón', async () => {
    const m = montar({ enlace: null });
    const r = await m.servicio.crear(
      { ...CREAR, permisos: ['tareas.ver'] },
      actor(['tareas.ver']),
    );
    expect(r.invitacionEnviada).toBe(true);
    expect(r.enlaceIncluido).toBe(false);
  });
});

describe('EquipoService.crear — el techo de privilegios', () => {
  // Un caso por cada clave que una cuadrícula puede dibujar (Finanzas y
  // Administración): el creador tiene todas MENOS una.
  it.each(OFRECIDAS)(
    'no puede otorgar %s directa si no la tiene (403 que la nombra)',
    async (clave) => {
      const m = montar();
      const caller = actor(OFRECIDAS.filter((c) => c !== clave));

      const intento = m.servicio.crear({ ...CREAR, permisos: [clave] }, caller);

      await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
      await expect(intento).rejects.toThrow(clave);
      expect(m.firebase.crear).not.toHaveBeenCalled();
      expect(m.cuentasModel.create).not.toHaveBeenCalled();
      expect(m.asignacionesModel.create).not.toHaveBeenCalled();
    },
  );

  it.each(OFRECIDAS)(
    'no puede otorgar %s a través de un rol si no la tiene',
    async (clave) => {
      const r1 = rol({ permisos: [clave] });
      const m = montar({ roles: [r1] });
      const caller = actor(OFRECIDAS.filter((c) => c !== clave));

      await expect(
        m.servicio.crear({ ...CREAR, rolIds: [r1._id.toString()] }, caller),
      ).rejects.toThrow(clave);
      expect(m.firebase.crear).not.toHaveBeenCalled();
    },
  );

  it('nombra todas las claves que exceden, no solo la primera', async () => {
    const m = montar();
    await expect(
      m.servicio.crear(
        { ...CREAR, permisos: ['tareas.ver', 'anuncios.crear', 'zonas.ver'] },
        actor(['tareas.ver']),
      ),
    ).rejects.toThrow(/anuncios\.crear.*zonas\.ver/);
  });

  it('el administrador de la plataforma queda exento del techo', async () => {
    const m = montar();
    const r = await m.servicio.crear(
      { ...CREAR, permisos: ['roles.gestionar', 'usuarios.eliminar'] },
      actor([], { isPlatformAdmin: true }),
    );
    expect(r.miembro.perfil).toBe('personal');
  });

  it('un solo permiso de más hace fallar toda la petición sin crear nada', async () => {
    const m = montar();
    await expect(
      m.servicio.crear(
        { ...CREAR, permisos: ['tareas.ver', 'config.editar'] },
        actor(['tareas.ver']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.storeAsig).toHaveLength(0);
    expect(m.storeCuentas).toHaveLength(0);
  });

  it.each([
    'facturas.ver',
    'facturas.anular',
    'recibos.crear',
    'consultas.ver',
    'inmuebles.depurar',
    'recibos.aprobar',
  ])(
    'otorga la clave de Finanzas %s a quien la tiene (S-D1.2)',
    async (clave) => {
      const m = montar();

      const r = await m.servicio.crear(
        { ...CREAR, permisos: [clave] },
        actor([clave]),
      );

      expect(r.miembro.permisos).toEqual([clave]);
      expect(m.asignacionesModel.create.mock.calls[0][0][0].permisos).toEqual([
        clave,
      ]);
    },
  );

  it.each([
    'tareas.volar',
    'pqr.eliminar',
    'inmuebles.aprobar',
    'facturas.gestionar',
  ])(
    'una clave NUEVA que no se ofrece (%s) es 400, aun para quien la tiene o para un administrador de plataforma, y no crea nada (S-D1.1, D1.3, D1.4)',
    async (clave) => {
      const m = montar();
      await expect(
        m.servicio.crear({ ...CREAR, permisos: [clave] }, actor([clave])),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        m.servicio.crear(
          { ...CREAR, permisos: [clave] },
          actor([], { isPlatformAdmin: true }),
        ),
      ).rejects.toThrow(`Permisos que no existen: ${clave}`);
      expect(m.firebase.crear).not.toHaveBeenCalled();
      expect(m.storeAsig).toHaveLength(0);
    },
  );

  it('un 400 por clave inexistente gana al 403 por clave sin tener', async () => {
    const m = montar();
    await expect(
      m.servicio.crear(
        { ...CREAR, permisos: ['facturas.anular', 'tareas.volar'] },
        actor([]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un rol de OTRA copropiedad es 400 y no crea nada', async () => {
    const ajeno = rol({ copropiedadId: OTRA_COP });
    const m = montar({ roles: [ajeno] });

    await expect(
      m.servicio.crear(
        { ...CREAR, rolIds: [ajeno._id.toString()] },
        actor(['tareas.ver']),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.firebase.crear).not.toHaveBeenCalled();
    expect(m.storeAsig).toHaveLength(0);
  });

  it('un rol inexistente mezclado con uno válido es 400', async () => {
    const bueno = rol();
    const m = montar({ roles: [bueno] });
    await expect(
      m.servicio.crear(
        {
          ...CREAR,
          rolIds: [bueno._id.toString(), new Types.ObjectId().toString()],
        },
        actor(['tareas.ver']),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('las claves de Finanzas de un rol cuentan y se limitan como cualquier otra (S-D2.6, D2.9)', async () => {
    const mixto = rol({ permisos: ['tareas.ver', 'facturas.anular'] });
    const m = montar({ roles: [mixto] });

    await expect(
      m.servicio.crear(
        { ...CREAR, rolIds: [mixto._id.toString()] },
        actor(['tareas.ver']),
      ),
    ).rejects.toThrow(
      'No puedes otorgar ni quitar permisos que no tienes: facturas.anular',
    );
    expect(m.firebase.crear).not.toHaveBeenCalled();
    expect(m.storeAsig).toHaveLength(0);

    await expect(
      m.servicio.crear(
        { ...CREAR, rolIds: [mixto._id.toString()] },
        actor(['tareas.ver', 'facturas.anular']),
      ),
    ).resolves.toBeDefined();
  });

  it('las claves de un rol que no se ofrecen (gestionar de Finanzas, no ofrecida) no se cuentan', async () => {
    const legado = rol({
      permisos: ['tareas.ver', 'facturas.gestionar', 'inmuebles.aprobar'],
    });
    const m = montar({ roles: [legado] });

    await expect(
      m.servicio.crear(
        { ...CREAR, rolIds: [legado._id.toString()] },
        actor(['tareas.ver']),
      ),
    ).resolves.toBeDefined();
  });

  it('un administrador de plataforma no necesita tener las claves de un rol de Finanzas', async () => {
    const r1 = rol({ permisos: ['facturas.anular'] });
    const m = montar({ roles: [r1] });
    await expect(
      m.servicio.crear(
        { ...CREAR, rolIds: [r1._id.toString()] },
        actor([], { isPlatformAdmin: true }),
      ),
    ).resolves.toBeDefined();
  });

  it('exige al menos un rol o permiso', async () => {
    const m = montar();
    await expect(
      m.servicio.crear(CREAR, actor(['tareas.ver'])),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      m.servicio.crear({ ...CREAR, permisos: [] }, actor(['tareas.ver'])),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el perfil creado es siempre personal, venga lo que venga en la petición', async () => {
    const m = montar();
    const hostil = {
      ...CREAR,
      permisos: ['tareas.ver'],
      perfil: 'administrativo',
      alcance: 'entidad',
      esAdministradorPlataforma: true,
    } as never;

    await m.servicio.crear(hostil, actor(['tareas.ver']));

    const creada = m.asignacionesModel.create.mock.calls[0][0][0];
    expect(creada.perfil).toBe('personal');
    expect(creada.alcance).toBe('copropiedad');
    expect(creada.entidadId).toBeNull();
    expect(
      m.cuentasModel.create.mock.calls[0][0].esAdministradorPlataforma,
    ).toBe(false);
  });
});

describe('EquipoService.crear — auditoría con detalle y enlace de acceso', () => {
  it('la auditoría registra las claves efectivas agregadas (directas más las del rol), ordenadas (S-A1.1)', async () => {
    const r1 = rol({ permisos: ['pqr.ver'] });
    const m = montar({ roles: [r1] });

    await m.servicio.crear(
      { ...CREAR, permisos: ['tareas.ver'], rolIds: [r1._id.toString()] },
      actor(['tareas.ver', 'pqr.ver']),
    );

    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'crear',
        entidadTipo: 'usuario',
        detalle: detalle(['pqr.ver', 'tareas.ver'], []),
      }),
      expect.anything(),
    );
  });

  it('si la auditoría falla, la petición falla (S-A1.6)', async () => {
    const m = montar();
    m.auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));
    await expect(
      m.servicio.crear(
        { ...CREAR, permisos: ['tareas.ver'] },
        actor(['tareas.ver']),
      ),
    ).rejects.toThrow('sin auditoría');
  });

  it('un miembro creado con una clave de Finanzas directa recibe la invitación sin botón y con la salida por «Olvidé mi contraseña» (S-K1.1)', async () => {
    const m = montar({ enlaceSegunAcceso: true });

    const r = await m.servicio.crear(
      { ...CREAR, permisos: ['facturas.ver'] },
      actor(['facturas.ver']),
    );

    expect(r.invitacionEnviada).toBe(true);
    expect(r.enlaceIncluido).toBe(false);
    expect(m.enviados[0].html).toContain('Olvidé mi contraseña');
    expect(m.enviados[0].html).not.toContain('/auth/enlace');
  });

  it('lo mismo si la clave de Finanzas llega solo por un rol (S-K1.2)', async () => {
    const r1 = rol({ permisos: ['recibos.ver'] });
    const m = montar({ roles: [r1], enlaceSegunAcceso: true });

    const r = await m.servicio.crear(
      { ...CREAR, rolIds: [r1._id.toString()] },
      actor(['recibos.ver']),
    );

    expect(r.invitacionEnviada).toBe(true);
    expect(r.enlaceIncluido).toBe(false);
    expect(m.enviados[0].html).toContain('Olvidé mi contraseña');
  });

  it('reenviar la invitación a un miembro con Finanzas tampoco lleva botón (S-K1.3)', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { permisos: ['facturas.ver'] });
    const m = montar({
      cuentas: [c],
      asignaciones: [a],
      enlaceSegunAcceso: true,
    });

    const r = await m.servicio.reenviarInvitacion(a._id.toString());

    expect(r).toEqual({ invitacionEnviada: true, enlaceIncluido: false });
    expect(m.enviados[0].html).toContain('Olvidé mi contraseña');
  });

  it('con solo claves de Administración el enlace sigue incluido (S-K1.5)', async () => {
    const m = montar({ enlaceSegunAcceso: true });
    const r = await m.servicio.crear(
      { ...CREAR, permisos: ['tareas.ver'] },
      actor(['tareas.ver']),
    );
    expect(r.enlaceIncluido).toBe(true);
  });
});

describe('EquipoService.crear — cuentas que ya existen', () => {
  const dto = { ...CREAR, permisos: ['tareas.ver'] };
  const caller = () => actor(['tareas.ver']);

  it('sin vincularExistente es 409: no se adueña de la cuenta en silencio', async () => {
    const c = cuenta({ email: 'nuevo@correo.co' });
    const m = montar({ cuentas: [c] });

    await expect(m.servicio.crear(dto, caller())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.storeAsig).toHaveLength(0);
    expect(m.firebase.crear).not.toHaveBeenCalled();
  });

  it('el 409 lleva el código estable CUENTA_EXISTENTE y conserva el mensaje', async () => {
    const c = cuenta({ email: 'nuevo@correo.co' });
    const m = montar({ cuentas: [c] });

    const error = await m.servicio
      .crear(dto, caller())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'CUENTA_EXISTENTE',
      message: expect.stringContaining('vincularExistente') as string,
    });
  });

  it('con vincularExistente le suma una asignación personal sin tocar Firebase ni la cuenta', async () => {
    const c = cuenta({ email: 'nuevo@correo.co' });
    const m = montar({ cuentas: [c] });

    const r = await m.servicio.crear(
      { ...dto, vincularExistente: true },
      caller(),
    );

    expect(r.cuentaExistente).toBe(true);
    expect(m.firebase.crear).not.toHaveBeenCalled();
    expect(m.cuentasModel.create).not.toHaveBeenCalled();
    expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
    expect(m.asignacionesModel.create).toHaveBeenCalledWith(
      [expect.objectContaining({ accountId: c._id, perfil: 'personal' })],
      { session: m.sesiones[0] },
    );
    expect(m.enviados[0].html).toContain('contraseña de siempre');
  });

  it('quien se suma a sí mismo es 403, no escribe nada y no audita: ni reactivando su fila personal inactiva ni creándola (p. ej. con acceso de entidad)', async () => {
    const yo = cuenta({ email: 'nuevo@correo.co' });
    const yoMismo = actor(['tareas.ver'], { accountId: yo._id.toString() });
    const inactiva = asignacion(yo._id, { estado: 'inactive', permisos: [] });
    const reactivando = montar({ cuentas: [yo], asignaciones: [inactiva] });

    await expect(
      reactivando.servicio.crear({ ...dto, vincularExistente: true }, yoMismo),
    ).rejects.toThrow('No puedes modificar tu propio acceso');
    expect(inactiva.estado).toBe('inactive');
    expect(inactiva.permisos).toEqual([]);

    const creando = montar({ cuentas: [yo] });
    await expect(
      creando.servicio.crear({ ...dto, vincularExistente: true }, yoMismo),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(creando.asignacionesModel.create).not.toHaveBeenCalled();
    expect(creando.storeAsig).toHaveLength(0);
    expect(creando.auditoria.registrar).not.toHaveBeenCalled();
    expect(creando.firebase.crear).not.toHaveBeenCalled();
  });

  it('rechaza (409) a un administrador de la plataforma, aun con el indicador', async () => {
    const c = cuenta({
      email: 'nuevo@correo.co',
      esAdministradorPlataforma: true,
    });
    const m = montar({ cuentas: [c] });
    await expect(
      m.servicio.crear({ ...dto, vincularExistente: true }, caller()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.storeAsig).toHaveLength(0);
  });

  it('rechaza (409) una cuenta inactiva', async () => {
    const c = cuenta({ email: 'nuevo@correo.co', estado: 'inactive' });
    const m = montar({ cuentas: [c] });
    await expect(
      m.servicio.crear({ ...dto, vincularExistente: true }, caller()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una cuenta que ya tiene asignación activa aquí es 409', async () => {
    const c = cuenta({ email: 'nuevo@correo.co' });
    const m = montar({ cuentas: [c], asignaciones: [asignacion(c._id)] });
    await expect(
      m.servicio.crear({ ...dto, vincularExistente: true }, caller()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.asignacionesModel.create).not.toHaveBeenCalled();
  });

  it('una administrativa desactivada aquí solo la restablece la plataforma (409)', async () => {
    const c = cuenta({ email: 'nuevo@correo.co' });
    const previa = asignacion(c._id, {
      perfil: 'administrativo',
      estado: 'inactive',
    });
    const m = montar({ cuentas: [c], asignaciones: [previa] });
    await expect(
      m.servicio.crear({ ...dto, vincularExistente: true }, caller()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(previa.estado).toBe('inactive');
  });

  it('reactiva una asignación personal inactiva con el permiso NUEVO, sin mezclar el viejo', async () => {
    const c = cuenta({ email: 'nuevo@correo.co' });
    const previa = asignacion(c._id, {
      estado: 'inactive',
      permisos: ['config.editar'],
    });
    const m = montar({ cuentas: [c], asignaciones: [previa] });

    const r = await m.servicio.crear(
      { ...dto, vincularExistente: true },
      caller(),
    );

    expect(previa.estado).toBe('active');
    expect(previa.permisos).toEqual(['tareas.ver']);
    expect(m.asignacionesModel.create).not.toHaveBeenCalled();
    expect(r.miembro.id).toBe(previa._id.toString());
  });

  it('al reactivar, lo que tenía antes no cuenta: el "antes" es vacío y no se juzga como una quita (S-D2)', async () => {
    const c = cuenta({ email: 'nuevo@correo.co' });
    const previa = asignacion(c._id, {
      estado: 'inactive',
      permisos: ['facturas.anular', 'anuncios.ver'],
    });
    const m = montar({ cuentas: [c], asignaciones: [previa] });

    await m.servicio.crear({ ...dto, vincularExistente: true }, caller());

    // The caller holds neither old key; nothing is "removed", only 'tareas.ver' is given.
    expect(previa.permisos).toEqual(['tareas.ver']);
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'crear',
        detalle: detalle(['tareas.ver'], []),
      }),
      expect.anything(),
    );
  });

  it('si Firebase ya conoce el correo (sin cuenta local) es 409 y no deja cuenta ni asignación', async () => {
    const m = montar({ firebaseConoce: ['nuevo@correo.co'] });
    await expect(m.servicio.crear(dto, caller())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.storeCuentas).toHaveLength(0);
    expect(m.storeAsig).toHaveLength(0);
  });

  it('una carrera sobre el índice único (accountId, copropiedadId) es 409', async () => {
    const m = montar();
    m.asignacionesModel.create.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 11000 }),
    );
    await expect(m.servicio.crear(dto, caller())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('EquipoService.actualizar', () => {
  const caller = (extra: string[] = []) =>
    actor(['tareas.ver', 'anuncios.ver', ...extra]);

  it('reemplaza permisos y roles, filtrando por id, copropiedad y perfil personal', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });

    const r = await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['anuncios.ver'] },
      caller(),
    );

    expect(a.permisos).toEqual(['anuncios.ver']);
    const filtro = m.asignacionesModel.updateOne.mock.calls[0][0];
    expect(String(filtro.copropiedadId)).toBe(COP.toString());
    expect(filtro.perfil).toBe('personal');
    expect(filtro.estado).toBe('active');
    expect(r.permisos).toEqual(['anuncios.ver']);
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'actualizar',
        detalle: detalle(['anuncios.ver'], ['tareas.ver']),
      }),
      expect.anything(),
    );
  });

  it('no puede otorgar de más al editar (403) ni un rol ajeno (400)', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const ajeno = rol({ copropiedadId: OTRA_COP });
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [ajeno] });

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['config.editar'] },
        caller(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { rolIds: [ajeno._id.toString()] },
        caller(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(a.permisos).toEqual(['tareas.ver']);
  });

  it('no puede editarse a sí mismo (ni subirse ni bajarse el acceso)', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });
    const yo = actor(['tareas.ver', 'usuarios.editar'], {
      accountId: c._id.toString(),
    });

    await expect(
      m.servicio.actualizar(a._id.toString(), { permisos: [] }, yo),
    ).rejects.toThrow('No puedes modificar tu propio acceso');
    expect(a.permisos).toEqual(['tareas.ver']);
  });

  it('no puede tocar una asignación administrativa', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { perfil: 'administrativo' });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.ver'] },
        caller(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una fila legada sin perfil se trata como administrativa', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    delete (a as Partial<AsignacionFake>).perfil;
    const m = montar({ cuentas: [c], asignaciones: [a] });
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.ver'] },
        caller(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no puede tocar a un administrador de la plataforma, aunque tenga asignación personal', async () => {
    const c = cuenta({ esAdministradorPlataforma: true });
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.ver'] },
        caller(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una asignación de otra copropiedad, de alcance entidad o un id mal formado es 404', async () => {
    const c = cuenta();
    const ajena = asignacion(c._id, { copropiedadId: OTRA_COP });
    const porEntidad = asignacion(c._id, {
      alcance: 'entidad',
      copropiedadId: null,
      entidadId: new Types.ObjectId(),
    });
    const m = montar({ cuentas: [c], asignaciones: [ajena, porEntidad] });

    for (const id of [
      ajena._id.toString(),
      porEntidad._id.toString(),
      'no-es-id',
    ]) {
      await expect(
        m.servicio.actualizar(id, { permisos: ['tareas.ver'] }, caller()),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(m.asignacionesModel.updateOne).not.toHaveBeenCalled();
  });

  it('no deja a la persona sin ningún rol ni permiso', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });
    await expect(
      m.servicio.actualizar(a._id.toString(), { permisos: [] }, caller()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una asignación desactivada no se edita (409)', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { estado: 'inactive' });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.ver'] },
        caller(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('renombra solo si la cuenta es exclusiva de este edificio', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });
    await m.servicio.actualizar(
      a._id.toString(),
      { nombre: 'Nombre Nuevo' },
      caller(),
    );
    expect(c.nombreCompleto).toBe('Nombre Nuevo');

    const c2 = cuenta({ email: 'otra@correo.co' });
    const a2 = asignacion(c2._id);
    const otraObra = asignacion(c2._id, { copropiedadId: OTRA_COP });
    const m2 = montar({ cuentas: [c2], asignaciones: [a2, otraObra] });
    await expect(
      m2.servicio.actualizar(
        a2._id.toString(),
        { nombre: 'Intento' },
        caller(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(c2.nombreCompleto).toBe('Persona Uno');
  });

  it('un miembro que ademas es residente (vinculo heredado o direccion probada) con una sola asignacion SI se renombra (S-A6.1, S-A6.3)', async () => {
    // Staff and resident are the same person whose permissions add up: being a
    // resident (a `Tercero.accountId` link, which this service no longer reads,
    // or an address proof on the Account) is not "used elsewhere".
    const c = cuenta({ email: 'residente@correo.co' }) as CuentaFake & {
      correoProbadoClave?: string;
    };
    c.correoProbadoClave = 'a'.repeat(64);
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await m.servicio.actualizar(
      a._id.toString(),
      { nombre: 'Nombre Nuevo' },
      caller(),
    );

    expect(c.nombreCompleto).toBe('Nombre Nuevo');
  });

  it('un miembro que ademas es residente con una SEGUNDA asignacion sigue sin poder renombrarse, con la frase de siempre (S-A6.2)', async () => {
    const c = cuenta({ email: 'doble@correo.co' });
    const a = asignacion(c._id);
    const otraObra = asignacion(c._id, { copropiedadId: OTRA_COP });
    const m = montar({ cuentas: [c], asignaciones: [a, otraObra] });

    await expect(
      m.servicio.actualizar(a._id.toString(), { nombre: 'Intento' }, caller()),
    ).rejects.toThrow(
      'Esa cuenta se usa en otras copropiedades: el nombre se cambia desde la consola de la plataforma',
    );
    expect(c.nombreCompleto).toBe('Persona Uno');
  });
});

describe('EquipoService.actualizar — el techo al agregar y al quitar', () => {
  /** Ana holds `tareas.ver` and `facturas.ver`. */
  const ana = (extra: string[] = []) =>
    actor(['tareas.ver', 'facturas.ver', ...extra]);

  const miembro = (over: Partial<AsignacionFake> = {}) => {
    const c = cuenta();
    const a = asignacion(c._id, over);
    return { c, a };
  };

  it('agrega una clave de Finanzas que tiene (S-D2.1)', async () => {
    const { c, a } = miembro();
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['tareas.ver', 'facturas.ver'] },
      ana(),
    );

    expect(a.permisos).toEqual(['tareas.ver', 'facturas.ver']);
  });

  it('agregar una que no tiene es 403 y la nombra; la fila no cambia (S-D2.2)', async () => {
    const { c, a } = miembro();
    const m = montar({ cuentas: [c], asignaciones: [a] });

    const intento = m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['tareas.ver', 'facturas.anular'] },
      ana(),
    );

    await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
    await expect(intento).rejects.toThrow('facturas.anular');
    expect(a.permisos).toEqual(['tareas.ver']);
    expect(m.asignacionesModel.updateOne).not.toHaveBeenCalled();
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('quitar una clave que no tiene es 403 y la nombra (S-D2.3)', async () => {
    const { c, a } = miembro({ permisos: ['tareas.ver', 'anuncios.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    const intento = m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['tareas.ver'] },
      ana(),
    );

    await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
    await expect(intento).rejects.toThrow('anuncios.ver');
    expect(a.permisos).toEqual(['tareas.ver', 'anuncios.ver']);
  });

  it('reenviar sin cambios una clave que no tiene es 200 y la conserva (S-D2.4)', async () => {
    const { c, a } = miembro({ permisos: ['anuncios.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['anuncios.ver', 'tareas.ver'] },
      ana(),
    );

    expect(a.permisos).toEqual(['anuncios.ver', 'tareas.ver']);
  });

  it('`tareas.gestionar` de Administración no da derecho a dar `tareas.ver` (S-D2.5)', async () => {
    const { c, a } = miembro({ permisos: ['pqr.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    const intento = m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['pqr.ver', 'tareas.ver'] },
      actor(['pqr.ver', 'tareas.gestionar']),
    );

    await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
    await expect(intento).rejects.toThrow('tareas.ver');
  });

  it('en Finanzas la clave es exacta: con `facturas.ver` y `facturas.crear` puede dar esas dos y no `facturas.anular` (S-D2.5)', async () => {
    const { c, a } = miembro({ permisos: ['pqr.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    const caller = actor(['pqr.ver', 'facturas.ver', 'facturas.crear']);

    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['pqr.ver', 'facturas.ver', 'facturas.crear'] },
      caller,
    );
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        {
          permisos: [
            'pqr.ver',
            'facturas.ver',
            'facturas.crear',
            'facturas.anular',
          ],
        },
        caller,
      ),
    ).rejects.toThrow('facturas.anular');
    expect(a.permisos).toEqual(['pqr.ver', 'facturas.ver', 'facturas.crear']);
  });

  it('adjuntar un rol con una clave que no tiene es 403 (S-D2.6)', async () => {
    const r1 = rol({ permisos: ['facturas.anular'] });
    const { c, a } = miembro();
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [r1] });

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { rolIds: [r1._id.toString()] },
        ana(),
      ),
    ).rejects.toThrow('facturas.anular');
    expect(a.roleIds).toEqual([]);
  });

  it('quitar un rol cuya clave no tiene es 403 (S-D2.7)', async () => {
    const r1 = rol({ permisos: ['anuncios.ver'] });
    const { c, a } = miembro({ roleIds: [r1._id] });
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [r1] });

    const intento = m.servicio.actualizar(
      a._id.toString(),
      { rolIds: [] },
      ana(),
    );

    await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
    await expect(intento).rejects.toThrow('anuncios.ver');
    expect(a.roleIds).toEqual([r1._id]);
  });

  it('cuenta el conjunto efectivo, no la lista literal: quitar la copia directa o mover el rol sin cambiar el conjunto es 200 (S-D2.8)', async () => {
    const r1 = rol({ permisos: ['anuncios.ver'] });
    // Ana lacks anuncios.ver. The member has it directly AND through R.
    const { c, a } = miembro({
      permisos: ['tareas.ver', 'anuncios.ver'],
      roleIds: [r1._id],
    });
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [r1] });

    // Drop the direct copy: the role still brings it.
    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['tareas.ver'] },
      ana(),
    );
    expect(a.permisos).toEqual(['tareas.ver']);

    // Detach the role while the direct copy is back: still the same set.
    a.permisos = ['tareas.ver', 'anuncios.ver'];
    await m.servicio.actualizar(a._id.toString(), { rolIds: [] }, ana());
    expect(a.roleIds).toEqual([]);

    // Attach it again while the direct copy remains: still the same set.
    await m.servicio.actualizar(
      a._id.toString(),
      { rolIds: [r1._id.toString()] },
      ana(),
    );
    expect(a.roleIds).toEqual([r1._id]);
  });

  it('un administrador de plataforma sin claves agrega y quita cualquier clave conocida (S-D2.10)', async () => {
    const { c, a } = miembro({ permisos: ['anuncios.ver', 'facturas.anular'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    const root = actor([], { isPlatformAdmin: true });

    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['recibos.crear', 'roles.gestionar'] },
      root,
    );

    expect(a.permisos).toEqual(['recibos.crear', 'roles.gestionar']);
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.volar'] },
        root,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una clave de un módulo que quizá no esté contratado se juzga igual que cualquier otra (S-D2.11)', async () => {
    const { c, a } = miembro();
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.ver', 'pqr.ver'] },
        ana(),
      ),
    ).rejects.toThrow('pqr.ver');
    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['tareas.ver', 'pqr.ver'] },
      ana(['pqr.ver']),
    );
    expect(a.permisos).toEqual(['tareas.ver', 'pqr.ver']);
  });

  it('solo renombrar no toca claves: ni techo, ni escritura condicional, y audita con listas vacías (S-D2.12, A1.3)', async () => {
    const { c, a } = miembro({ permisos: ['anuncios.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await m.servicio.actualizar(
      a._id.toString(),
      { nombre: 'Nombre Nuevo' },
      actor([]),
    );

    expect(c.nombreCompleto).toBe('Nombre Nuevo');
    expect(m.asignacionesModel.updateOne).not.toHaveBeenCalled();
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'actualizar',
        detalle: detalle([], []),
      }),
      expect.anything(),
    );
  });

  it('un rol de OTRA copropiedad que el miembro aún nombra no aporta claves (S-D6)', async () => {
    const ajeno = rol({
      copropiedadId: OTRA_COP,
      permisos: ['facturas.anular'],
    });
    const { c, a } = miembro({ roleIds: [ajeno._id] });
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [ajeno] });

    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['tareas.ver', 'facturas.ver'] },
      ana(),
    );

    expect(a.permisos).toEqual(['tareas.ver', 'facturas.ver']);
  });

  it('sin colusión: quien tiene `tareas.ver` no puede dar la `anuncios.ver` de otro, pero sí la suya (S-D7.1)', async () => {
    const { c, a } = miembro({ permisos: ['pqr.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    const anaSolo = actor(['pqr.ver', 'tareas.ver']);

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['pqr.ver', 'anuncios.ver'] },
        anaSolo,
      ),
    ).rejects.toThrow('anuncios.ver');
    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['pqr.ver', 'tareas.ver'] },
      anaSolo,
    );
    expect(a.permisos).toEqual(['pqr.ver', 'tareas.ver']);
  });

  it('claves guardadas que no se ofrecen (S-D1.5, D2.14): reenviadas sin cambios o dejadas fuera, 200; una NUEVA, 400', async () => {
    const { c, a } = miembro({
      permisos: ['tareas.ver', 'facturas.gestionar', 'inmuebles.aprobar'],
    });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    const id = a._id.toString();

    // Re-sent untouched while a held key is added: not judged, travels back.
    await m.servicio.actualizar(
      id,
      {
        permisos: [
          'tareas.ver',
          'facturas.gestionar',
          'inmuebles.aprobar',
          'facturas.ver',
        ],
      },
      ana(),
    );
    expect(a.permisos).toEqual([
      'tareas.ver',
      'facturas.gestionar',
      'inmuebles.aprobar',
      'facturas.ver',
    ]);

    // Left out: dropped freely, Ana holds neither.
    await m.servicio.actualizar(id, { permisos: ['tareas.ver'] }, ana());
    expect(a.permisos).toEqual(['tareas.ver']);

    // The same keys as NEW are not offered: 400, for a platform admin too.
    for (const clave of ['facturas.gestionar', 'inmuebles.aprobar']) {
      await expect(
        m.servicio.actualizar(id, { permisos: ['tareas.ver', clave] }, ana()),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        m.servicio.actualizar(
          id,
          { permisos: ['tareas.ver', clave] },
          actor([], { isPlatformAdmin: true }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(a.permisos).toEqual(['tareas.ver']);
  });

  it('un 400 por rol ajeno o por clave inexistente gana al 403 por falta de claves', async () => {
    const ajeno = rol({ copropiedadId: OTRA_COP });
    const { c, a } = miembro({ permisos: ['anuncios.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [ajeno] });

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { rolIds: [ajeno._id.toString()] },
        actor([]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.volar'] },
        actor([]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un administrativo con claves de Finanzas sigue intocable para editar, retirar y reinvitar aunque el editor las tenga (S-D5.1)', async () => {
    const c = cuenta();
    const adm = asignacion(c._id, {
      perfil: 'administrativo',
      permisos: ['facturas.ver'],
    });
    const m = montar({ cuentas: [c], asignaciones: [adm] });
    const id = adm._id.toString();

    await expect(
      m.servicio.actualizar(id, { permisos: ['facturas.ver'] }, ana()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.servicio.desactivar(id, ana())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(m.servicio.reenviarInvitacion(id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(adm.estado).toBe('active');
  });

  it('la auditoría de una edición lista lo agregado y lo quitado, ordenado (S-A1.2) y su fallo rechaza la petición (S-A1.6)', async () => {
    const { c, a } = miembro({ permisos: ['tareas.ver', 'anuncios.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    const caller = actor([
      'tareas.ver',
      'anuncios.ver',
      'facturas.ver',
      'pqr.ver',
    ]);

    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['pqr.ver', 'facturas.ver', 'anuncios.ver'] },
      caller,
    );
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        detalle: detalle(['facturas.ver', 'pqr.ver'], ['tareas.ver']),
      }),
      expect.anything(),
    );

    m.auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['pqr.ver'] },
        caller,
      ),
    ).rejects.toThrow('sin auditoría');
  });

  it('una fila sin el campo `roleIds` se edita igual (la condición de "vacío" acepta ausente)', async () => {
    const { c, a } = miembro();
    delete (a as Partial<AsignacionFake>).roleIds;
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['tareas.ver', 'facturas.ver'] },
      ana(),
    );

    expect(a.permisos).toEqual(['tareas.ver', 'facturas.ver']);
  });
});

describe('EquipoService.actualizar — escritura condicional', () => {
  const ana = () => actor(['tareas.ver', 'facturas.ver', 'pqr.ver']);

  it('si otro editor cambió `permisos` entre la lectura y la escritura: 409 y no se escribe nada (S-D4.1)', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { permisos: ['tareas.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    // B adds 'pqr.ver' after A read the row.
    entreLecturaYEscritura(m, () => {
      a.permisos = ['tareas.ver', 'pqr.ver'];
    });

    const intento = m.servicio.actualizar(
      a._id.toString(),
      { permisos: ['facturas.ver'], nombre: 'Cambio' },
      ana(),
    );

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['facturas.ver'] },
        ana(),
      ),
    ).resolves.toBeDefined(); // a retry sees the new state and goes through
  });

  it('el 409 no deja rastro: ni renombre ni auditoría, y la clave del otro editor sigue (S-D4.1)', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { permisos: ['tareas.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    entreLecturaYEscritura(m, () => {
      a.permisos = ['tareas.ver', 'pqr.ver'];
    });

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['facturas.ver'], nombre: 'Cambio' },
        ana(),
      ),
    ).rejects.toThrow(
      'El acceso cambió mientras se procesaba: vuelve a intentarlo',
    );

    expect(a.permisos).toEqual(['tareas.ver', 'pqr.ver']);
    expect(c.nombreCompleto).toBe('Persona Uno');
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('lo mismo si cambiaron los `roleIds` (S-D4.2)', async () => {
    const r1 = rol();
    const c = cuenta();
    const a = asignacion(c._id, { permisos: ['tareas.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [r1] });
    entreLecturaYEscritura(m, () => {
      a.roleIds = [r1._id];
    });

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['facturas.ver'] },
        ana(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(a.permisos).toEqual(['tareas.ver']);
  });

  it('desactivar contra una concesión simultánea: 409 y el miembro sigue activo (S-D4.3)', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { permisos: ['tareas.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    entreLecturaYEscritura(m, () => {
      a.permisos = ['tareas.ver', 'facturas.anular'];
    });

    await expect(
      m.servicio.desactivar(a._id.toString(), actor(['tareas.ver'])),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(a.estado).toBe('active');
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('desactivar si otro ya lo desactivó entre la lectura y la escritura: 409, sin segundo registro', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { permisos: ['tareas.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    entreLecturaYEscritura(m, () => {
      a.estado = 'inactive';
    });

    await expect(
      m.servicio.desactivar(a._id.toString(), actor(['tareas.ver'])),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('sin `permisos` ni `rolIds` no hay condición sobre claves: ni siquiera se escribe la asignación (S-D4.4)', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });
    entreLecturaYEscritura(m, () => {
      a.permisos = ['tareas.ver', 'pqr.ver'];
    });

    await m.servicio.actualizar(
      a._id.toString(),
      { nombre: 'Nombre Nuevo' },
      actor([]),
    );

    expect(c.nombreCompleto).toBe('Nombre Nuevo');
    expect(m.asignacionesModel.updateOne).not.toHaveBeenCalled();
  });
});

describe('EquipoService.desactivar', () => {
  // The member of these tests holds `tareas.ver`, so the caller must too.
  const caller = () => actor(['usuarios.eliminar', 'tareas.ver']);

  it('apaga solo la asignación de esta copropiedad y no toca la cuenta ni Firebase', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const otraObra = asignacion(c._id, { copropiedadId: OTRA_COP });
    const m = montar({ cuentas: [c], asignaciones: [a, otraObra] });

    const r = await m.servicio.desactivar(a._id.toString(), caller());

    expect(r).toEqual({ id: a._id.toString() });
    expect(a.estado).toBe('inactive');
    expect(otraObra.estado).toBe('active');
    expect(c.estado).toBe('active');
    expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
    expect(m.cuentasModel.deleteOne).not.toHaveBeenCalled();
    expect(m.firebase.establecerHabilitado).not.toHaveBeenCalled();
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'retirar',
        entidadId: c._id.toString(),
        detalle: detalle([], ['tareas.ver']),
      }),
      expect.anything(),
    );
    const filtro = m.asignacionesModel.updateOne.mock.calls[0][0];
    expect(String(filtro.copropiedadId)).toBe(COP.toString());
    expect(filtro.estado).toBe('active');
  });

  it('exige tener TODAS las claves del miembro: si le falta una directa, 403 que la nombra y sigue activo (S-D3.2)', async () => {
    const c = cuenta();
    const a = asignacion(c._id, {
      permisos: ['tareas.ver', 'facturas.anular'],
    });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    const intento = m.servicio.desactivar(a._id.toString(), caller());

    await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
    await expect(intento).rejects.toThrow(
      'No puedes desactivar a alguien con permisos que tú no tienes: facturas.anular',
    );
    expect(a.estado).toBe('active');
    expect(m.asignacionesModel.updateOne).not.toHaveBeenCalled();
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('también cuenta lo que el miembro tiene solo a través de un rol (S-D3.3)', async () => {
    const r1 = rol({ permisos: ['anuncios.ver'] });
    const c = cuenta();
    const a = asignacion(c._id, { roleIds: [r1._id] });
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [r1] });

    await expect(
      m.servicio.desactivar(a._id.toString(), caller()),
    ).rejects.toThrow('anuncios.ver');
    expect(a.estado).toBe('active');
  });

  it('quien tiene todo lo del miembro (directo y por rol) puede desactivarlo y queda en la auditoría (S-D3.1)', async () => {
    const r1 = rol({ permisos: ['anuncios.ver'] });
    const c = cuenta();
    const a = asignacion(c._id, {
      permisos: ['tareas.ver', 'facturas.ver'],
      roleIds: [r1._id],
    });
    const m = montar({ cuentas: [c], asignaciones: [a], roles: [r1] });

    await m.servicio.desactivar(
      a._id.toString(),
      actor(['tareas.ver', 'facturas.ver', 'anuncios.ver']),
    );

    expect(a.estado).toBe('inactive');
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'retirar',
        detalle: detalle([], ['anuncios.ver', 'facturas.ver', 'tareas.ver']),
      }),
      expect.anything(),
    );
  });

  it('un miembro cuyo conjunto efectivo está vacío (solo claves no ofrecidas o desconocidas) se desactiva sin más (S-D3.4)', async () => {
    const c = cuenta();
    const a = asignacion(c._id, {
      permisos: ['facturas.gestionar', 'inmuebles.aprobar'],
    });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await m.servicio.desactivar(a._id.toString(), actor([]));

    expect(a.estado).toBe('inactive');
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ detalle: detalle([], []) }),
      expect.anything(),
    );
  });

  it('un administrador de plataforma desactiva a cualquiera', async () => {
    const c = cuenta();
    const a = asignacion(c._id, {
      permisos: ['facturas.anular', 'tareas.ver'],
    });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await m.servicio.desactivar(
      a._id.toString(),
      actor([], { isPlatformAdmin: true }),
    );

    expect(a.estado).toBe('inactive');
  });

  it('no se puede dejar sin nada a un colega más rico: el junior no desactiva al que tiene `facturas.anular` (S-D3.6)', async () => {
    const c = cuenta();
    const colega = asignacion(c._id, {
      permisos: ['facturas.ver', 'facturas.anular'],
    });
    const m = montar({ cuentas: [c], asignaciones: [colega] });
    const jo = actor(['usuarios.eliminar', 'facturas.ver']);

    await expect(
      m.servicio.desactivar(colega._id.toString(), jo),
    ).rejects.toThrow('facturas.anular');
    expect(colega.estado).toBe('active');
  });

  it('repetir sobre uno ya inactivo es 200 sin comprobar claves, sin escribir y sin auditar (S-D3 idempotente)', async () => {
    const c = cuenta();
    const a = asignacion(c._id, {
      estado: 'inactive',
      permisos: ['facturas.anular'],
    });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await expect(
      m.servicio.desactivar(a._id.toString(), actor([])),
    ).resolves.toEqual({ id: a._id.toString() });
    expect(m.asignacionesModel.updateOne).not.toHaveBeenCalled();
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('si la auditoría falla, la petición falla (S-A1.6)', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });
    m.auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));
    await expect(
      m.servicio.desactivar(a._id.toString(), caller()),
    ).rejects.toThrow('sin auditoría');
  });

  it('no puede desactivarse a sí mismo', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });
    await expect(
      m.servicio.desactivar(
        a._id.toString(),
        actor(['usuarios.eliminar'], { accountId: c._id.toString() }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(a.estado).toBe('active');
  });

  it('no puede desactivar una administrativa ni a un administrador de plataforma', async () => {
    const c1 = cuenta();
    const adm = asignacion(c1._id, { perfil: 'administrativo' });
    const c2 = cuenta({
      email: 'root@correo.co',
      esAdministradorPlataforma: true,
    });
    const root = asignacion(c2._id);
    const m = montar({ cuentas: [c1, c2], asignaciones: [adm, root] });

    await expect(
      m.servicio.desactivar(adm._id.toString(), caller()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      m.servicio.desactivar(root._id.toString(), caller()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(adm.estado).toBe('active');
    expect(root.estado).toBe('active');
  });

  it('es idempotente y no audita dos veces', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { estado: 'inactive' });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    await m.servicio.desactivar(a._id.toString(), caller());
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('el miembro de otra copropiedad es 404', async () => {
    const c = cuenta();
    const ajena = asignacion(c._id, { copropiedadId: OTRA_COP });
    const m = montar({ cuentas: [c], asignaciones: [ajena] });
    await expect(
      m.servicio.desactivar(ajena._id.toString(), caller()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ajena.estado).toBe('active');
  });
});

describe('EquipoService.reenviarInvitacion', () => {
  it('envía al correo de la cuenta de un miembro activo', async () => {
    const c = cuenta({ email: 'persona@correo.co' });
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });

    const r = await m.servicio.reenviarInvitacion(a._id.toString());

    expect(r.invitacionEnviada).toBe(true);
    expect(m.enviados[0].para).toBe('persona@correo.co');
    expect(m.firebase.crear).not.toHaveBeenCalled();
  });

  it('no invita a un administrador de plataforma, a una administrativa ni a un desactivado', async () => {
    const root = cuenta({ esAdministradorPlataforma: true });
    const aRoot = asignacion(root._id);
    const c = cuenta({ email: 'b@correo.co' });
    const adm = asignacion(c._id, { perfil: 'administrativo' });
    const d = cuenta({ email: 'c@correo.co' });
    const inactiva = asignacion(d._id, { estado: 'inactive' });
    const m = montar({
      cuentas: [root, c, d],
      asignaciones: [aRoot, adm, inactiva],
    });

    await expect(
      m.servicio.reenviarInvitacion(aRoot._id.toString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      m.servicio.reenviarInvitacion(adm._id.toString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      m.servicio.reenviarInvitacion(inactiva._id.toString()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('sin correo configurado lo declara', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({
      cuentas: [c],
      asignaciones: [a],
      correoConfigurado: false,
    });
    expect(await m.servicio.reenviarInvitacion(a._id.toString())).toEqual({
      invitacionEnviada: false,
      enlaceIncluido: false,
    });
  });
});

describe('EquipoService.listar / obtener', () => {
  it('lista solo el personal de esta copropiedad, activo por defecto, sin exponer el id de cuenta', async () => {
    const c1 = cuenta({ nombreCompleto: 'Zoe', email: 'zoe@x.co' });
    const c2 = cuenta({ nombreCompleto: 'Ana', email: 'ana@x.co' });
    const c3 = cuenta({ nombreCompleto: 'Lejos', email: 'lejos@x.co' });
    const c4 = cuenta({ nombreCompleto: 'Baja', email: 'baja@x.co' });
    const m = montar({
      cuentas: [c1, c2, c3, c4],
      asignaciones: [
        asignacion(c1._id),
        asignacion(c2._id, { perfil: 'administrativo' }),
        asignacion(c3._id, { copropiedadId: OTRA_COP }),
        asignacion(c4._id, { estado: 'inactive' }),
      ],
    });

    const lista = await m.servicio.listar({});

    expect(lista.map((x) => x.nombre)).toEqual(['Ana', 'Zoe']);
    expect(lista.find((x) => x.nombre === 'Ana')).toMatchObject({
      perfil: 'administrativo',
      editable: false,
    });
    expect(lista.find((x) => x.nombre === 'Zoe')).toMatchObject({
      editable: true,
    });
    for (const c of [c1, c2, c3, c4])
      expect(JSON.stringify(lista)).not.toContain(c._id.toString());
    expect(
      String(m.asignacionesModel.find.mock.calls[0][0].copropiedadId),
    ).toBe(COP.toString());

    const todos = await m.servicio.listar({ estado: 'todos' });
    expect(todos.map((x) => x.nombre)).toEqual(['Ana', 'Baja', 'Zoe']);
  });

  it('marca como no editable a un administrador de plataforma y busca por nombre o correo', async () => {
    const root = cuenta({
      nombreCompleto: 'Root',
      email: 'root@x.co',
      esAdministradorPlataforma: true,
    });
    const otro = cuenta({ nombreCompleto: 'Otro', email: 'otro@x.co' });
    const m = montar({
      cuentas: [root, otro],
      asignaciones: [asignacion(root._id), asignacion(otro._id)],
    });

    const todos = await m.servicio.listar({});
    expect(todos.find((x) => x.nombre === 'Root')).toMatchObject({
      editable: false,
      esAdministradorPlataforma: true,
    });
    expect(
      (await m.servicio.listar({ buscar: 'OTRO' })).map((x) => x.nombre),
    ).toEqual(['Otro']);
  });

  it('obtener devuelve 404 para otra copropiedad o un id mal formado', async () => {
    const c = cuenta();
    const ajena = asignacion(c._id, { copropiedadId: OTRA_COP });
    const m = montar({ cuentas: [c], asignaciones: [ajena] });
    await expect(
      m.servicio.obtener(ajena._id.toString()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.servicio.obtener('xx')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('EquipoService — el cambio y su entrada de auditoría van en una sola transacción', () => {
  const caller = () =>
    actor(['usuarios.eliminar', 'usuarios.editar', 'tareas.ver', 'pqr.ver']);
  const sinAuditoria = (m: ReturnType<typeof montar>) =>
    m.auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));

  it('crear con cuenta nueva: la asignación y la entrada comparten sesión; la identidad y la cuenta quedan fuera', async () => {
    const m = montar();

    await m.servicio.crear(
      { ...CREAR, permisos: ['tareas.ver'] },
      actor(['usuarios.crear', 'tareas.ver']),
    );

    expect(m.sesiones).toHaveLength(1);
    // The Account is written outside the transaction: no options, no session.
    expect(m.cuentasModel.create.mock.calls[0]).toHaveLength(1);
    expect(m.asignacionesModel.create.mock.calls[0][1]).toEqual({
      session: m.sesiones[0],
    });
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'crear' }),
      m.sesiones[0],
    );
    expect(m.sesiones[0].endSession).toHaveBeenCalled();
  });

  it('crear: si la auditoría falla no queda la asignación (sin cambio guardado y sin entrada); la identidad y la cuenta inertes sí, y el reintento topa con la regla de cuenta existente', async () => {
    const m = montar();
    sinAuditoria(m);
    const dto = { ...CREAR, permisos: ['tareas.ver'] };
    const quien = actor(['usuarios.crear', 'tareas.ver']);

    await expect(m.servicio.crear(dto, quien)).rejects.toThrow('sin auditoría');

    expect(m.sesiones[0].deshecha).toBe(true);
    expect(m.storeAsig).toHaveLength(0);
    expect(m.storeCuentas).toHaveLength(1);
    expect(m.identidades.has('nuevo@correo.co')).toBe(true);
    expect(m.enviados).toHaveLength(0);
    await expect(m.servicio.crear(dto, quien)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CUENTA_EXISTENTE',
      }) as unknown,
    });
    expect(m.firebase.crear).toHaveBeenCalledTimes(1);
  });

  it('crear vinculando una cuenta existente que reactiva su fila: si la auditoría falla la fila sigue inactiva y con sus claves viejas', async () => {
    const c = cuenta({ email: 'nuevo@correo.co' });
    const previa = asignacion(c._id, {
      estado: 'inactive',
      permisos: ['config.editar'],
    });
    const m = montar({ cuentas: [c], asignaciones: [previa] });
    sinAuditoria(m);

    await expect(
      m.servicio.crear(
        { ...CREAR, permisos: ['tareas.ver'], vincularExistente: true },
        actor(['usuarios.crear', 'tareas.ver']),
      ),
    ).rejects.toThrow('sin auditoría');

    expect(previa.estado).toBe('inactive');
    expect(previa.permisos).toEqual(['config.editar']);
    expect(m.asignacionesModel.updateOne.mock.calls[0][2]).toEqual({
      session: m.sesiones[0],
    });
  });

  it('actualizar: claves, nombre y entrada comparten sesión; si la auditoría falla no cambia ni lo uno ni lo otro', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { permisos: ['tareas.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    sinAuditoria(m);

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.ver', 'pqr.ver'], nombre: 'Nombre Nuevo' },
        caller(),
      ),
    ).rejects.toThrow('sin auditoría');

    expect(m.sesiones[0].deshecha).toBe(true);
    expect(a.permisos).toEqual(['tareas.ver']);
    expect(c.nombreCompleto).toBe('Persona Uno');
    expect(m.asignacionesModel.updateOne.mock.calls[0][2]).toEqual({
      session: m.sesiones[0],
    });
    expect(m.cuentasModel.updateOne.mock.calls[0][2]).toEqual({
      session: m.sesiones[0],
    });
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.anything(),
      m.sesiones[0],
    );
  });

  it('actualizar: un conflicto de lo que cambió mientras tanto (409) deshace también el cambio de nombre y no audita', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { permisos: ['tareas.ver'] });
    const m = montar({ cuentas: [c], asignaciones: [a] });
    entreLecturaYEscritura(m, () => a.permisos.push('pqr.ver'));

    await expect(
      m.servicio.actualizar(
        a._id.toString(),
        { permisos: ['tareas.ver', 'pqr.ver'], nombre: 'Nombre Nuevo' },
        caller(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(c.nombreCompleto).toBe('Persona Uno');
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('desactivar: la baja y la entrada comparten sesión; si la auditoría falla el miembro sigue activo', async () => {
    const c = cuenta();
    const a = asignacion(c._id);
    const m = montar({ cuentas: [c], asignaciones: [a] });
    sinAuditoria(m);

    await expect(
      m.servicio.desactivar(a._id.toString(), caller()),
    ).rejects.toThrow('sin auditoría');

    expect(m.sesiones[0].deshecha).toBe(true);
    expect(a.estado).toBe('active');
    expect(m.asignacionesModel.updateOne.mock.calls[0][2]).toEqual({
      session: m.sesiones[0],
    });
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.anything(),
      m.sesiones[0],
    );
  });

  it('sin cambio que guardar (miembro ya inactivo) no abre transacción', async () => {
    const c = cuenta();
    const a = asignacion(c._id, { estado: 'inactive' });
    const m = montar({ cuentas: [c], asignaciones: [a] });

    await m.servicio.desactivar(a._id.toString(), caller());

    expect(m.conexion.startSession).not.toHaveBeenCalled();
  });
});
