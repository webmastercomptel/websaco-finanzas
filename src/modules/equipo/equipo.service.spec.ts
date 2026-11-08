import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { InvitacionAccesoService } from '../acceso-residentes/invitacion-acceso.service';
import { PERMISOS_ADMINISTRACION } from '../casl/permisos-catalogo';
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
    const v = item[k];
    if (cond === null) return v == null;
    if (cond instanceof Types.ObjectId) return mismo(v, cond);
    if (cond && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('$in' in c) return (c.$in as unknown[]).some((x) => mismo(x, v));
      if ('$ne' in c) return !mismo(v, c.$ne);
    }
    return v === cond;
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
  terceros?: Array<{ accountId: Types.ObjectId }>;
  correoConfigurado?: boolean;
  enlace?: string | null;
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
      consulta(() => storeAsig.filter((a) => coincide(a as never, f))),
    ),
    findOne: jest.fn((f: Record<string, unknown>) =>
      consulta(() => storeAsig.find((a) => coincide(a as never, f)) ?? null),
    ),
    create: jest.fn((doc: Omit<AsignacionFake, '_id'>) => {
      if (
        storeAsig.some(
          (a) =>
            mismo(a.accountId, doc.accountId) &&
            mismo(a.copropiedadId, doc.copropiedadId),
        )
      ) {
        return Promise.reject(Object.assign(new Error('dup'), { code: 11000 }));
      }
      const nueva = { _id: new Types.ObjectId(), ...doc };
      storeAsig.push(nueva);
      return Promise.resolve(nueva);
    }),
    updateOne: jest.fn(
      (f: Record<string, unknown>, u: { $set: Record<string, unknown> }) =>
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
      (f: { _id: Types.ObjectId }, u: { $set: Record<string, unknown> }) =>
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
  const tercerosModel = {
    exists: jest.fn((f: { accountId: Types.ObjectId }) =>
      consulta(
        () =>
          (opciones.terceros ?? []).find((t) =>
            mismo(t.accountId, f.accountId),
          ) ?? null,
      ),
    ),
  };
  const firebase = {
    crear: jest.fn((d: { email: string; password: string; nombre: string }) => {
      passwords.push(d.password);
      if (identidades.has(d.email)) {
        return Promise.reject(
          new ConflictException(
            `Ya existe una cuenta de Firebase con el correo ${d.email}.`,
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
    construir: jest.fn(() =>
      Promise.resolve(
        opciones.enlace === undefined
          ? 'https://app.co/auth/enlace?token=t'
          : opciones.enlace,
      ),
    ),
  };
  const copropiedades = {
    findById: jest.fn(() => consulta(() => ({ nombre: 'Edificio Central' }))),
  };
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const tenant = { resolveCoPropertyId: jest.fn(() => COP) };
  const invitaciones = new InvitacionAccesoService(
    correo as never,
    enlaces as never,
    copropiedades as never,
  );
  const servicio = new EquipoService(
    asignacionesModel as never,
    cuentasModel as never,
    rolesModel as never,
    tercerosModel as never,
    firebase as never,
    tenant as never,
    invitaciones,
    auditoria as never,
  );
  return {
    servicio,
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
      expect.objectContaining({
        perfil: 'personal',
        alcance: 'copropiedad',
        entidadId: null,
        estado: 'active',
        permisos: ['tareas.ver'],
      }),
    );
    expect(
      String(m.asignacionesModel.create.mock.calls[0][0].copropiedadId),
    ).toBe(COP.toString());
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAccountId: caller.accountId,
        accion: 'crear',
        entidadTipo: 'usuario',
      }),
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

    expect(m.asignacionesModel.create.mock.calls[0][0].roleIds).toEqual([
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
  // Un caso por cada clave del catálogo: el creador tiene todas MENOS una.
  it.each(CLAVES)(
    'no puede otorgar %s directa si no la tiene (403 que la nombra)',
    async (clave) => {
      const m = montar();
      const caller = actor(CLAVES.filter((c) => c !== clave));

      const intento = m.servicio.crear({ ...CREAR, permisos: [clave] }, caller);

      await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
      await expect(intento).rejects.toThrow(clave);
      expect(m.firebase.crear).not.toHaveBeenCalled();
      expect(m.cuentasModel.create).not.toHaveBeenCalled();
      expect(m.asignacionesModel.create).not.toHaveBeenCalled();
    },
  );

  it.each(CLAVES)(
    'no puede otorgar %s a través de un rol si no la tiene',
    async (clave) => {
      const r1 = rol({ permisos: [clave] });
      const m = montar({ roles: [r1] });
      const caller = actor(CLAVES.filter((c) => c !== clave));

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
    'inmuebles.gestionar',
  ])(
    'nunca otorga la clave de Finanzas %s, ni siquiera a quien la tiene o a un administrador de plataforma (400)',
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
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(m.firebase.crear).not.toHaveBeenCalled();
    },
  );

  it('una clave inventada es 400', async () => {
    const m = montar();
    await expect(
      m.servicio.crear(
        { ...CREAR, permisos: ['tareas.volar'] },
        actor([], { isPlatformAdmin: true }),
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

  it('un rol con claves de Finanzas no las transmite: solo cuentan las de Administración', async () => {
    const mixto = rol({ permisos: ['tareas.ver', 'facturas.anular'] });
    const m = montar({ roles: [mixto] });

    // The caller lacks facturas.anular; it is not "granted" (AccesoService drops it).
    await expect(
      m.servicio.crear(
        { ...CREAR, rolIds: [mixto._id.toString()] },
        actor(['tareas.ver']),
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

    const creada = m.asignacionesModel.create.mock.calls[0][0];
    expect(creada.perfil).toBe('personal');
    expect(creada.alcance).toBe('copropiedad');
    expect(creada.entidadId).toBeNull();
    expect(
      m.cuentasModel.create.mock.calls[0][0].esAdministradorPlataforma,
    ).toBe(false);
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
      expect.objectContaining({ accountId: c._id, perfil: 'personal' }),
    );
    expect(m.enviados[0].html).toContain('contraseña de siempre');
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
    expect(r.permisos).toEqual(['anuncios.ver']);
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'actualizar' }),
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

    const c3 = cuenta({ email: 'residente@correo.co' });
    const a3 = asignacion(c3._id);
    const m3 = montar({
      cuentas: [c3],
      asignaciones: [a3],
      terceros: [{ accountId: c3._id }],
    });
    await expect(
      m3.servicio.actualizar(
        a3._id.toString(),
        { nombre: 'Intento' },
        caller(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('EquipoService.desactivar', () => {
  const caller = () => actor(['usuarios.eliminar']);

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
      }),
    );
    const filtro = m.asignacionesModel.updateOne.mock.calls[0][0];
    expect(String(filtro.copropiedadId)).toBe(COP.toString());
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
