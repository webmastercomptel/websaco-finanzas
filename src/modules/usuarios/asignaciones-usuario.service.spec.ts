import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { AsignacionesUsuarioService } from './asignaciones-usuario.service';

interface AsignacionFake {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  perfil?: 'administrativo' | 'personal';
  alcance: 'copropiedad' | 'entidad';
  copropiedadId: Types.ObjectId | null;
  entidadId: Types.ObjectId | null;
  permisos: string[];
  roleIds: Types.ObjectId[];
  estado: 'active' | 'inactive';
  updatedAt?: string;
}
interface CuentaFake {
  _id: Types.ObjectId;
  nombreCompleto: string;
  esAdministradorPlataforma: boolean;
  estado: 'active' | 'inactive';
}
interface RolFake {
  _id: Types.ObjectId;
  copropiedadId: Types.ObjectId;
  permisos: string[];
}

const COP = new Types.ObjectId();
const OTRA_COP = new Types.ObjectId();
const ENT = new Types.ObjectId();

const cuenta = (over: Partial<CuentaFake> = {}): CuentaFake => ({
  _id: new Types.ObjectId(),
  nombreCompleto: 'Ana Pérez',
  esAdministradorPlataforma: false,
  estado: 'active',
  ...over,
});
const fila = (
  accountId: Types.ObjectId,
  over: Partial<AsignacionFake> = {},
): AsignacionFake => ({
  _id: new Types.ObjectId(),
  accountId,
  perfil: 'administrativo',
  alcance: 'copropiedad',
  copropiedadId: COP,
  entidadId: null,
  permisos: ['facturas.ver'],
  roleIds: [],
  estado: 'active',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const filaEntidad = (
  accountId: Types.ObjectId,
  over: Partial<AsignacionFake> = {},
): AsignacionFake =>
  fila(accountId, {
    alcance: 'entidad',
    copropiedadId: null,
    entidadId: ENT,
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

/** What a query hands back: a copy, so a race can change the store in between. */
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
    session: () => q,
    lean: () => q,
    exec: () => Promise.resolve(resultado()),
  };
  return q;
};

const ACTOR = { accountId: 'actor-1', nombre: 'Admin Test' };

interface Opciones {
  cuentas?: CuentaFake[];
  asignaciones?: AsignacionFake[];
  roles?: RolFake[];
  /** Targets that exist. Defaults to COP, OTRA_COP (coproperties) and ENT. */
  copropiedades?: Array<{ _id: Types.ObjectId; nombre: string }>;
  entidades?: Array<{ _id: Types.ObjectId; nombre: string }>;
  /** Makes `create` reject, e.g. a concurrent insert (E11000). */
  errorAlCrear?: Error;
}

function montar(opciones: Opciones = {}) {
  const storeCuentas = opciones.cuentas ?? [];
  const storeAsig = opciones.asignaciones ?? [];
  const storeRoles = opciones.roles ?? [];
  const storeCops = opciones.copropiedades ?? [
    { _id: COP, nombre: 'Edificio Central' },
    { _id: OTRA_COP, nombre: 'Torre Norte' },
  ];
  const storeEnts = opciones.entidades ?? [
    { _id: ENT, nombre: 'Administradora Sur' },
  ];

  const asignacionesModel = {
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
        if (opciones.errorAlCrear) return Promise.reject(opciones.errorAlCrear);
        const [doc] = docs;
        if (
          storeAsig.some(
            (a) =>
              mismo(a.accountId, doc.accountId) &&
              mismo(a.copropiedadId, doc.copropiedadId) &&
              mismo(a.entidadId, doc.entidadId),
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
          Object.assign(a, u.$set, { updatedAt: 'tocada' });
          return { matchedCount: 1 };
        }),
    ),
  };
  const cuentasModel = {
    findById: jest.fn((id: Types.ObjectId) =>
      consulta(() => storeCuentas.find((c) => mismo(c._id, id)) ?? null),
    ),
    updateOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
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
  const copropiedadesModel = {
    findById: jest.fn((id: Types.ObjectId) =>
      consulta(() => storeCops.find((c) => mismo(c._id, id)) ?? null),
    ),
  };
  const entidadesModel = {
    findById: jest.fn((id: Types.ObjectId) =>
      consulta(() => storeEnts.find((c) => mismo(c._id, id)) ?? null),
    ),
  };
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };

  // A transaction that behaves like Mongo's where it matters here: what the
  // callback wrote is undone when it throws.
  const sesiones: Array<{ deshecha: boolean; endSession: jest.Mock }> = [];
  const conexion = {
    startSession: jest.fn(() => {
      const sesion = {
        deshecha: false,
        endSession: jest.fn().mockResolvedValue(undefined),
        withTransaction: async (fn: () => Promise<void>) => {
          const foto = storeAsig.map((f) => ({ f, antes: copia(f) }));
          const largo = storeAsig.length;
          try {
            await fn();
          } catch (error) {
            sesion.deshecha = true;
            storeAsig.length = 0;
            for (const { f, antes } of foto) {
              Object.assign(f, antes);
              storeAsig.push(f);
            }
            void largo;
            throw error;
          }
        },
      };
      sesiones.push(sesion);
      return Promise.resolve(sesion);
    }),
  };

  const servicio = new AsignacionesUsuarioService(
    asignacionesModel as never,
    cuentasModel as never,
    rolesModel as never,
    copropiedadesModel as never,
    entidadesModel as never,
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
    copropiedadesModel,
    entidadesModel,
    auditoria,
    storeAsig,
    storeCuentas,
  };
}

type M = ReturnType<typeof montar>;

/** A deep, comparable copy of rows, to prove an operation left them untouched. */
const instantanea = (filas: AsignacionFake[]) =>
  JSON.parse(JSON.stringify(filas)) as unknown;

/** Runs `efecto` once, between the service's read of the row and its write. */
const entreLecturaYEscritura = (m: M, efecto: () => void): void => {
  const original = m.copropiedadesModel.findById.getMockImplementation()!;
  m.copropiedadesModel.findById.mockImplementationOnce((id: Types.ObjectId) => {
    efecto();
    return original(id);
  });
};

const detalle = (agregadas: string[], quitadas: string[]) => ({
  agregadas,
  quitadas,
});

const agregarCop = (
  permisos: string[] = ['facturas.ver'],
  copropiedadId: string = COP.toString(),
) => ({ alcance: 'copropiedad' as const, copropiedadId, permisos });

/** Nothing was written: no row, no transaction, no entry, no Account write. */
const nadaEscrito = (m: M) => {
  expect(m.asignacionesModel.create).not.toHaveBeenCalled();
  expect(m.asignacionesModel.updateOne).not.toHaveBeenCalled();
  expect(m.auditoria.registrar).not.toHaveBeenCalled();
  expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
};

describe('AsignacionesUsuarioService.agregar — POST /usuarios/:id/asignaciones', () => {
  it('un destino sin fila: inserta una nueva administrativa, activa y sin roles (S-U3.1)', async () => {
    const ana = cuenta();
    const deA = fila(ana._id, { copropiedadId: OTRA_COP });
    const m = montar({ cuentas: [ana], asignaciones: [deA] });
    const antes = instantanea([deA]);

    await m.servicio.agregar(
      ana._id.toString(),
      agregarCop(['facturas.ver']),
      ACTOR,
    );

    expect(m.asignacionesModel.create).toHaveBeenCalledWith(
      [
        {
          accountId: ana._id,
          alcance: 'copropiedad',
          copropiedadId: COP,
          entidadId: null,
          permisos: ['facturas.ver'],
          perfil: 'administrativo',
          roleIds: [],
          estado: 'active',
        },
      ],
      expect.objectContaining({ session: expect.anything() }),
    );
    // The other row of the account is untouched, and so is the Account.
    expect(instantanea([deA])).toEqual(antes);
    expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
    expect(m.storeAsig).toHaveLength(2);
  });

  it('una entidad guarda entidadId y copropiedadId null', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana] });

    await m.servicio.agregar(
      ana._id.toString(),
      { alcance: 'entidad', entidadId: ENT.toString(), permisos: [] },
      ACTOR,
    );

    expect(m.asignacionesModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          alcance: 'entidad',
          entidadId: ENT,
          copropiedadId: null,
          permisos: [],
        }),
      ],
      expect.anything(),
    );
  });

  it('solo lee el id que corresponde al alcance, aunque venga el otro (la fila nunca guarda los dos)', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana] });

    await m.servicio.agregar(
      ana._id.toString(),
      {
        alcance: 'copropiedad',
        copropiedadId: COP.toString(),
        entidadId: ENT.toString(),
        permisos: [],
      },
      ACTOR,
    );

    expect(m.asignacionesModel.create).toHaveBeenCalledWith(
      [expect.objectContaining({ copropiedadId: COP, entidadId: null })],
      expect.anything(),
    );
  });

  it('una fila INACTIVA de cualquier perfil se reactiva: mismo id, administrativa, claves enviadas, roles vacíos (S-U3.4, S-U3.5)', async () => {
    const ana = cuenta();
    const rolId = new Types.ObjectId();
    const vieja = fila(ana._id, {
      perfil: 'personal',
      estado: 'inactive',
      permisos: ['tareas.ver'],
      roleIds: [rolId],
    });
    const m = montar({ cuentas: [ana], asignaciones: [vieja] });
    const idVieja = vieja._id;

    await m.servicio.agregar(
      ana._id.toString(),
      agregarCop(['pqr.ver']),
      ACTOR,
    );

    expect(m.asignacionesModel.create).not.toHaveBeenCalled();
    expect(m.storeAsig).toHaveLength(1);
    expect(m.storeAsig[0]).toMatchObject({
      _id: idVieja,
      perfil: 'administrativo',
      estado: 'active',
      permisos: ['pqr.ver'],
      roleIds: [],
    });
  });

  it('una fila ACTIVA administrativa del destino: 409 que manda a editarla, sin escribir nada (S-U3.6)', async () => {
    const ana = cuenta();
    const existente = fila(ana._id);
    const m = montar({ cuentas: [ana], asignaciones: [existente] });
    const antes = instantanea([existente]);

    const intento = m.servicio.agregar(
      ana._id.toString(),
      agregarCop(['pqr.ver']),
      ACTOR,
    );

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(/edítalo/i);
    nadaEscrito(m);
    expect(instantanea([existente])).toEqual(antes);
  });

  it('una fila ACTIVA personal del destino: 409 que nombra a Equipo, fila intacta (S-U3.7)', async () => {
    const ana = cuenta();
    const deEquipo = fila(ana._id, {
      perfil: 'personal',
      roleIds: [new Types.ObjectId()],
    });
    const m = montar({ cuentas: [ana], asignaciones: [deEquipo] });
    const antes = instantanea([deEquipo]);

    const intento = m.servicio.agregar(
      ana._id.toString(),
      agregarCop(['pqr.ver']),
      ACTOR,
    );

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(/Equipo/);
    nadaEscrito(m);
    expect(instantanea([deEquipo])).toEqual(antes);
  });

  it('el mismo destino con el id en mayúsculas es el mismo objetivo: 409, nunca una fila duplicada (S-U3.8)', async () => {
    const ana = cuenta();
    const existente = fila(ana._id);
    const m = montar({ cuentas: [ana], asignaciones: [existente] });

    await expect(
      m.servicio.agregar(
        ana._id.toString(),
        agregarCop([], COP.toString().toUpperCase()),
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(m.storeAsig).toHaveLength(1);
    // The lookup keys on the ObjectId built from the id, as the unique index does.
    expect(m.asignacionesModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ copropiedadId: COP }),
    );
  });

  it('una fila inactiva con el id en mayúsculas también se reactiva en sitio', async () => {
    const ana = cuenta();
    const vieja = fila(ana._id, { estado: 'inactive' });
    const m = montar({ cuentas: [ana], asignaciones: [vieja] });

    await m.servicio.agregar(
      ana._id.toString(),
      agregarCop(['pqr.ver'], COP.toString().toUpperCase()),
      ACTOR,
    );

    expect(m.storeAsig).toHaveLength(1);
    expect(m.storeAsig[0].estado).toBe('active');
  });

  it('una carrera con otra alta del mismo destino (E11000): 409 y no queda entrada de auditoría (S-U3.13)', async () => {
    const ana = cuenta();
    const m = montar({
      cuentas: [ana],
      errorAlCrear: Object.assign(new Error('dup'), { code: 11000 }),
    });

    const intento = m.servicio.agregar(ana._id.toString(), agregarCop(), ACTOR);

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(
      'Otra solicitud creó ese acceso al mismo tiempo: vuelve a intentarlo',
    );
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('un error de escritura que no es clave duplicada se propaga tal cual', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana], errorAlCrear: new Error('caído') });

    await expect(
      m.servicio.agregar(ana._id.toString(), agregarCop(), ACTOR),
    ).rejects.toThrow('caído');
  });

  it('una cuenta de administrador de plataforma: 409, no necesita fila (S-U3.16)', async () => {
    const root = cuenta({ esAdministradorPlataforma: true });
    const m = montar({ cuentas: [root] });

    await expect(
      m.servicio.agregar(root._id.toString(), agregarCop(), ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    nadaEscrito(m);
  });

  it.each([
    ['una cuenta que no existe', new Types.ObjectId().toString()],
    ['un id malformado', 'no-es-un-id'],
    ['un id de 12 caracteres, que ObjectId.isValid aceptaría', 'abcdefghijkl'],
  ])('%s: 404, nunca 500 (S-U3.12)', async (_caso, id) => {
    const m = montar();

    await expect(
      m.servicio.agregar(id, agregarCop(), ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    nadaEscrito(m);
  });

  it('una copropiedad que no existe: 404 «La copropiedad no existe», sin escribir (S-U3.17)', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana] });

    const intento = m.servicio.agregar(
      ana._id.toString(),
      agregarCop([], new Types.ObjectId().toString()),
      ACTOR,
    );

    await expect(intento).rejects.toBeInstanceOf(NotFoundException);
    await expect(intento).rejects.toThrow('La copropiedad no existe');
    nadaEscrito(m);
  });

  it('una entidad que no existe: 404 «La entidad no existe»', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana] });

    const intento = m.servicio.agregar(
      ana._id.toString(),
      {
        alcance: 'entidad',
        entidadId: new Types.ObjectId().toString(),
        permisos: [],
      },
      ACTOR,
    );

    await expect(intento).rejects.toBeInstanceOf(NotFoundException);
    await expect(intento).rejects.toThrow('La entidad no existe');
  });

  it('un destino que existe pero está inactivo se acepta (inerte al leer) (S-U3.17)', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana] });

    await expect(
      m.servicio.agregar(ana._id.toString(), agregarCop(), ACTOR),
    ).resolves.toBeUndefined();
    expect(m.asignacionesModel.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['tareas.volar', 'una clave que no existe'],
    ['inmuebles.aprobar', 'una clave válida en gramática pero no ofrecida'],
    ['facturas.gestionar', 'una clave heredada que ya no existe'],
  ])(
    'una clave NUEVA no ofrecida (%s: %s): 400 que la nombra, ANTES de cualquier escritura (S-U3.10)',
    async (clave) => {
      const ana = cuenta();
      const m = montar({ cuentas: [ana] });

      const intento = m.servicio.agregar(
        ana._id.toString(),
        agregarCop(['facturas.ver', clave]),
        ACTOR,
      );

      await expect(intento).rejects.toBeInstanceOf(BadRequestException);
      await expect(intento).rejects.toThrow(
        `Permisos que no existen: ${clave}`,
      );
      nadaEscrito(m);
      expect(m.conexion.startSession).not.toHaveBeenCalled();
    },
  );

  it('`permisos: []` crea la fila sin claves y la entrada no agrega nada (S-U3.14)', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana] });

    await m.servicio.agregar(ana._id.toString(), agregarCop([]), ACTOR);

    expect(m.storeAsig[0].permisos).toEqual([]);
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ detalle: detalle([], []) }),
      expect.anything(),
    );
  });

  it('ni Account ni ninguna otra fila se escriben, aunque la cuenta esté inactiva (S-U7.2, S-U7.3)', async () => {
    const ana = cuenta({ estado: 'inactive' });
    const otra = fila(ana._id, { copropiedadId: OTRA_COP });
    const m = montar({ cuentas: [ana], asignaciones: [otra] });
    const antes = instantanea([otra]);

    await m.servicio.agregar(ana._id.toString(), agregarCop(), ACTOR);

    expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
    expect(m.cuentasModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ana.estado).toBe('inactive');
    expect(instantanea([otra])).toEqual(antes);
  });
});

describe('AsignacionesUsuarioService.actualizar — PATCH /usuarios/:id/asignaciones/:asignacionId', () => {
  const editar = (
    m: M,
    c: CuentaFake,
    f: AsignacionFake,
    dto: { permisos?: string[]; estado?: 'activo' | 'inactivo' },
  ) => m.servicio.actualizar(c._id.toString(), f._id.toString(), dto, ACTOR);

  it('edita SOLO las claves de esa fila; las demás filas quedan idénticas (S-U4.1, S-U7.1)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, { permisos: ['facturas.ver'] });
    const hermana = fila(ana._id, { copropiedadId: OTRA_COP });
    const deEquipo = filaEntidad(ana._id, {
      perfil: 'personal',
      roleIds: [new Types.ObjectId()],
    });
    const m = montar({
      cuentas: [ana],
      asignaciones: [objetivo, hermana, deEquipo],
    });
    const antesOtras = instantanea([hermana, deEquipo]);

    await editar(m, ana, objetivo, { permisos: ['facturas.ver', 'pqr.ver'] });

    expect(m.storeAsig[0].permisos).toEqual(['facturas.ver', 'pqr.ver']);
    expect(instantanea([hermana, deEquipo])).toEqual(antesOtras);
    expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
  });

  it('`permisos: []` deja la fila sin claves y activa (S-U4.2)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id);
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

    await editar(m, ana, objetivo, { permisos: [] });

    expect(m.storeAsig[0]).toMatchObject({ permisos: [], estado: 'active' });
  });

  it('una edición de claves no toca roleIds ni el perfil (S-U4.7)', async () => {
    const ana = cuenta();
    const rolId = new Types.ObjectId();
    const objetivo = fila(ana._id, { roleIds: [rolId] });
    const m = montar({
      cuentas: [ana],
      asignaciones: [objetivo],
      roles: [{ _id: rolId, copropiedadId: COP, permisos: ['tareas.ver'] }],
    });

    await editar(m, ana, objetivo, { permisos: ['pqr.ver'] });

    expect(m.storeAsig[0].roleIds).toEqual([rolId]);
    const [, cambio] = m.asignacionesModel.updateOne.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(cambio.$set).toEqual({ permisos: ['pqr.ver'] });
  });

  it('una fila antigua sin perfil se edita como administrativa (S-U4.6)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id);
    delete objetivo.perfil;
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

    await editar(m, ana, objetivo, { permisos: ['pqr.ver'] });

    expect(m.storeAsig[0].permisos).toEqual(['pqr.ver']);
  });

  it('una fila personal: 403 que nombra a Equipo para claves, para estado y para reactivar; nada cambia (S-U4.5, S-U5.7, S-U5.8)', async () => {
    const ana = cuenta();
    const activa = fila(ana._id, { perfil: 'personal' });
    const inactiva = fila(ana._id, {
      perfil: 'personal',
      estado: 'inactive',
      copropiedadId: OTRA_COP,
    });
    const m = montar({ cuentas: [ana], asignaciones: [activa, inactiva] });
    const antes = instantanea([activa, inactiva]);

    const casos: Array<
      [AsignacionFake, { permisos?: string[]; estado?: 'activo' | 'inactivo' }]
    > = [
      [activa, { permisos: ['pqr.ver'] }],
      [activa, { estado: 'inactivo' }],
      [inactiva, { estado: 'activo' }],
    ];
    for (const [f, dto] of casos) {
      const intento = editar(m, ana, f, dto);
      await expect(intento).rejects.toBeInstanceOf(ForbiddenException);
      await expect(intento).rejects.toThrow(
        'Este acceso es del equipo de su copropiedad: se gestiona desde Equipo',
      );
    }
    nadaEscrito(m);
    expect(instantanea([activa, inactiva])).toEqual(antes);
  });

  it('una fila de OTRA cuenta (o un id que no es de esta cuenta): 404 y la otra fila queda intacta (S-U4.11)', async () => {
    const ana = cuenta();
    const beto = cuenta();
    const deBeto = fila(beto._id);
    const m = montar({ cuentas: [ana, beto], asignaciones: [deBeto] });
    const antes = instantanea([deBeto]);

    await expect(
      editar(m, ana, deBeto, { permisos: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);

    nadaEscrito(m);
    expect(instantanea([deBeto])).toEqual(antes);
  });

  it.each([['no-es-un-id'], ['abcdefghijkl']])(
    'un :asignacionId malformado (%s): 404, nunca 500 (S-U4.12)',
    async (id) => {
      const ana = cuenta();
      const m = montar({ cuentas: [ana] });

      await expect(
        m.servicio.actualizar(ana._id.toString(), id, { permisos: [] }, ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('una cuenta que no existe o un id de cuenta malformado: 404', async () => {
    const m = montar();

    await expect(
      m.servicio.actualizar(
        new Types.ObjectId().toString(),
        new Types.ObjectId().toString(),
        { permisos: [] },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      m.servicio.actualizar(
        'xx',
        new Types.ObjectId().toString(),
        { permisos: [] },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la misma lista otra vez: 200 sin escribir ni auditar ni abrir transacción (S-U4.9)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, { permisos: ['facturas.ver', 'pqr.ver'] });
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

    await expect(
      editar(m, ana, objetivo, { permisos: ['pqr.ver', 'facturas.ver'] }),
    ).resolves.toBeUndefined();

    nadaEscrito(m);
    expect(m.conexion.startSession).not.toHaveBeenCalled();
    expect(m.storeAsig[0].updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('una clave NUEVA no ofrecida: 400 que la nombra; una ya guardada que se reenvía se acepta (S-U4.3, S-U4.13)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, { permisos: ['inmuebles.aprobar'] });
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

    const nueva = editar(m, ana, objetivo, {
      permisos: ['inmuebles.aprobar', 'tareas.volar'],
    });
    await expect(nueva).rejects.toBeInstanceOf(BadRequestException);
    await expect(nueva).rejects.toThrow(
      'Permisos que no existen: tareas.volar',
    );
    nadaEscrito(m);

    await expect(
      editar(m, ana, objetivo, {
        permisos: ['inmuebles.aprobar', 'pqr.ver'],
      }),
    ).resolves.toBeUndefined();
    expect(m.storeAsig[0].permisos).toEqual(['inmuebles.aprobar', 'pqr.ver']);
  });

  it('una clave heredada guardada que quien edita omite se descarta como cualquier otra (S-U4.13)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, {
      permisos: ['facturas.gestionar', 'facturas.ver'],
    });
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

    await editar(m, ana, objetivo, { permisos: ['facturas.ver'] });

    expect(m.storeAsig[0].permisos).toEqual(['facturas.ver']);
  });

  it('una carrera: otra petición cambia las claves entre la lectura y la escritura: 409, sin escritura ni auditoría, y el otro cambio queda (S-U4.8)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, { permisos: ['facturas.ver'] });
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });
    entreLecturaYEscritura(m, () => {
      m.storeAsig[0].permisos = ['facturas.ver', 'tareas.ver'];
    });

    const intento = editar(m, ana, objetivo, { permisos: ['pqr.ver'] });

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(
      'El acceso cambió mientras se procesaba: vuelve a intentarlo',
    );
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
    expect(m.storeAsig[0].permisos).toEqual(['facturas.ver', 'tareas.ver']);
  });

  it('una carrera que desactiva la fila entre la lectura y la escritura: 409', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id);
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });
    entreLecturaYEscritura(m, () => {
      m.storeAsig[0].estado = 'inactive';
    });

    await expect(
      editar(m, ana, objetivo, { permisos: ['pqr.ver'] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('una carrera que cambia los roles de la fila entre la lectura y la escritura: 409', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id);
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });
    entreLecturaYEscritura(m, () => {
      m.storeAsig[0].roleIds = [new Types.ObjectId()];
    });

    await expect(
      editar(m, ana, objetivo, { permisos: ['pqr.ver'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una carrera que vuelve personal a la fila (Equipo la toma) entre la lectura y la escritura: 409', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id);
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });
    entreLecturaYEscritura(m, () => {
      m.storeAsig[0].perfil = 'personal';
    });

    await expect(
      editar(m, ana, objetivo, { permisos: ['pqr.ver'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  describe('desactivar y reactivar (PATCH estado)', () => {
    it('desactivar pone esa fila inactiva y nada más; las demás siguen activas e idénticas (S-U5.1)', async () => {
      const ana = cuenta();
      const objetivo = fila(ana._id);
      const hermana = fila(ana._id, { copropiedadId: OTRA_COP });
      const m = montar({ cuentas: [ana], asignaciones: [objetivo, hermana] });
      const antes = instantanea([hermana]);

      await editar(m, ana, objetivo, { estado: 'inactivo' });

      expect(m.storeAsig[0]).toMatchObject({
        estado: 'inactive',
        permisos: ['facturas.ver'],
      });
      expect(instantanea([hermana])).toEqual(antes);
      expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
    });

    it('desactivar la única fila activa funciona; la cuenta no se toca (S-U5.2)', async () => {
      const ana = cuenta();
      const objetivo = fila(ana._id);
      const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

      await editar(m, ana, objetivo, { estado: 'inactivo' });

      expect(m.storeAsig[0].estado).toBe('inactive');
      expect(ana.estado).toBe('active');
    });

    it('desactivar conserva los roleIds en la fila inactiva (S-U5.3)', async () => {
      const ana = cuenta();
      const rolId = new Types.ObjectId();
      const objetivo = fila(ana._id, { roleIds: [rolId] });
      const m = montar({
        cuentas: [ana],
        asignaciones: [objetivo],
        roles: [{ _id: rolId, copropiedadId: COP, permisos: ['tareas.ver'] }],
      });

      await editar(m, ana, objetivo, { estado: 'inactivo' });

      expect(m.storeAsig[0]).toMatchObject({
        estado: 'inactive',
        roleIds: [rolId],
      });
    });

    it('reactivar solo con estado: conserva las claves guardadas, vacía los roles y queda administrativa (S-U5.4)', async () => {
      const ana = cuenta();
      const rolId = new Types.ObjectId();
      const objetivo = fila(ana._id, {
        estado: 'inactive',
        permisos: ['facturas.ver'],
        roleIds: [rolId],
      });
      delete objetivo.perfil;
      const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

      await editar(m, ana, objetivo, { estado: 'activo' });

      expect(m.storeAsig[0]).toMatchObject({
        estado: 'active',
        permisos: ['facturas.ver'],
        roleIds: [],
        perfil: 'administrativo',
      });
    });

    it('reactivar con permisos: quedan exactamente esas claves y sin roles (S-U5.5)', async () => {
      const ana = cuenta();
      const objetivo = fila(ana._id, {
        estado: 'inactive',
        permisos: ['facturas.ver'],
        roleIds: [new Types.ObjectId()],
      });
      const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

      await editar(m, ana, objetivo, {
        estado: 'activo',
        permisos: ['pqr.ver'],
      });

      expect(m.storeAsig[0]).toMatchObject({
        estado: 'active',
        permisos: ['pqr.ver'],
        roleIds: [],
      });
    });

    it('reactivar una fila cuyo destino está inactivo funciona (S-U5.9)', async () => {
      const ana = cuenta();
      const objetivo = fila(ana._id, { estado: 'inactive' });
      const m = montar({
        cuentas: [ana],
        asignaciones: [objetivo],
        copropiedades: [],
      });

      await expect(
        editar(m, ana, objetivo, { estado: 'activo' }),
      ).resolves.toBeUndefined();
      expect(m.storeAsig[0].estado).toBe('active');
    });

    it('reactivar con una clave NUEVA no ofrecida es 400; una guardada que se reenvía se acepta', async () => {
      const ana = cuenta();
      const objetivo = fila(ana._id, {
        estado: 'inactive',
        permisos: ['inmuebles.aprobar'],
      });
      const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

      await expect(
        editar(m, ana, objetivo, {
          estado: 'activo',
          permisos: ['tareas.volar'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      nadaEscrito(m);

      await expect(
        editar(m, ana, objetivo, {
          estado: 'activo',
          permisos: ['inmuebles.aprobar'],
        }),
      ).resolves.toBeUndefined();
    });

    it('`inactivo` sobre una fila ya inactiva y `activo` sobre una ya activa: 200 sin escribir ni auditar (S-U5.6)', async () => {
      const ana = cuenta();
      const inactiva = fila(ana._id, { estado: 'inactive' });
      const activa = fila(ana._id, { copropiedadId: OTRA_COP });
      const m = montar({ cuentas: [ana], asignaciones: [inactiva, activa] });

      await editar(m, ana, inactiva, { estado: 'inactivo' });
      await editar(m, ana, activa, { estado: 'activo' });

      nadaEscrito(m);
    });

    it('`estado` y `permisos` juntos: una escritura y una entrada; `inactivo` con claves desactiva y guarda esas claves', async () => {
      const ana = cuenta();
      const objetivo = fila(ana._id, { permisos: ['facturas.ver'] });
      const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

      await editar(m, ana, objetivo, {
        estado: 'inactivo',
        permisos: ['pqr.ver'],
      });

      expect(m.asignacionesModel.updateOne).toHaveBeenCalledTimes(1);
      expect(m.auditoria.registrar).toHaveBeenCalledTimes(1);
      expect(m.storeAsig[0]).toMatchObject({
        estado: 'inactive',
        permisos: ['pqr.ver'],
      });
    });

    it('editar las claves de una fila INACTIVA las guarda y la deja inactiva', async () => {
      const ana = cuenta();
      const objetivo = fila(ana._id, { estado: 'inactive' });
      const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

      await editar(m, ana, objetivo, { permisos: ['pqr.ver'] });

      expect(m.storeAsig[0]).toMatchObject({
        estado: 'inactive',
        permisos: ['pqr.ver'],
      });
    });

    it('una fila de entidad se desactiva igual que una de copropiedad', async () => {
      const ana = cuenta();
      const objetivo = filaEntidad(ana._id);
      const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

      await editar(m, ana, objetivo, { estado: 'inactivo' });

      expect(m.storeAsig[0].estado).toBe('inactive');
      expect(m.entidadesModel.findById).toHaveBeenCalled();
    });
  });
});

describe('AsignacionesUsuarioService — aislamiento (REQ-U7)', () => {
  it('toda escritura lleva el _id de la fila Y el accountId en el filtro; nunca un filtro amplio (S-U7.1)', async () => {
    const ana = cuenta();
    const a = fila(ana._id);
    const b = fila(ana._id, { copropiedadId: OTRA_COP, estado: 'inactive' });
    const m = montar({ cuentas: [ana], asignaciones: [a, b] });

    await m.servicio.actualizar(
      ana._id.toString(),
      a._id.toString(),
      { permisos: ['pqr.ver'] },
      ACTOR,
    );
    await m.servicio.actualizar(
      ana._id.toString(),
      a._id.toString(),
      { estado: 'inactivo' },
      ACTOR,
    );
    await m.servicio.actualizar(
      ana._id.toString(),
      b._id.toString(),
      { estado: 'activo' },
      ACTOR,
    );
    // POST reactivating the inactive row of `a` (now inactive again).
    await m.servicio.agregar(
      ana._id.toString(),
      agregarCop(['facturas.ver']),
      ACTOR,
    );

    expect(
      m.asignacionesModel.updateOne.mock.calls.length,
    ).toBeGreaterThanOrEqual(4);
    for (const [filtro] of m.asignacionesModel.updateOne.mock
      .calls as unknown as Array<[Record<string, unknown>]>) {
      expect(filtro._id).toBeInstanceOf(Types.ObjectId);
      expect(mismo(filtro.accountId, ana._id)).toBe(true);
    }
  });

  it('la Account no se escribe jamás, tampoco al desactivar una fila de una cuenta inactiva (S-U7.3)', async () => {
    const ana = cuenta({ estado: 'inactive' });
    const a = fila(ana._id);
    const m = montar({ cuentas: [ana], asignaciones: [a] });

    await m.servicio.actualizar(
      ana._id.toString(),
      a._id.toString(),
      { estado: 'inactivo' },
      ACTOR,
    );

    expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
    expect(m.cuentasModel.create).not.toHaveBeenCalled();
    expect(ana.estado).toBe('inactive');
  });

  it('quien edita puede ser dueño de la cuenta que edita: sin regla de "no tocarse a uno mismo" (S-U7.5)', async () => {
    const yo = cuenta();
    const a = fila(yo._id);
    const m = montar({ cuentas: [yo], asignaciones: [a] });

    await expect(
      m.servicio.actualizar(
        yo._id.toString(),
        a._id.toString(),
        { permisos: ['pqr.ver'] },
        { accountId: yo._id.toString(), nombre: 'Yo' },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('AsignacionesUsuarioService — auditoría y transacción (REQ-U8)', () => {
  it('alta: una entrada `crear` con detalle ordenado, el actor autenticado y la sesión de la transacción (S-U8.1)', async () => {
    const ana = cuenta({ nombreCompleto: 'Ana Pérez' });
    const m = montar({ cuentas: [ana] });

    await m.servicio.agregar(
      ana._id.toString(),
      agregarCop(['pqr.ver', 'facturas.ver']),
      ACTOR,
    );

    expect(m.auditoria.registrar).toHaveBeenCalledTimes(1);
    const [entrada, sesion] = m.auditoria.registrar.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(entrada).toMatchObject({
      actorAccountId: 'actor-1',
      actorNombre: 'Admin Test',
      accion: 'crear',
      entidadTipo: 'usuario',
      entidadId: ana._id.toString(),
      detalle: detalle(['facturas.ver', 'pqr.ver'], []),
    });
    // The label names the person and the target.
    expect(entrada.entidadEtiqueta).toEqual(
      expect.stringContaining('Ana Pérez'),
    );
    expect(entrada.entidadEtiqueta).toEqual(
      expect.stringContaining('Edificio Central'),
    );
    expect(sesion).toBe(m.sesiones[0]);
    expect(m.sesiones[0].endSession).toHaveBeenCalled();
  });

  it('la etiqueta de una entidad nombra a la entidad', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana] });

    await m.servicio.agregar(
      ana._id.toString(),
      { alcance: 'entidad', entidadId: ENT.toString(), permisos: [] },
      ACTOR,
    );

    expect(m.auditoria.registrar.mock.calls[0][0]).toMatchObject({
      entidadEtiqueta: expect.stringContaining('Administradora Sur') as unknown,
    });
  });

  it('edición: `actualizar` con agregadas/quitadas (S-U8.2)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, { permisos: ['facturas.ver', 'pqr.ver'] });
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

    await m.servicio.actualizar(
      ana._id.toString(),
      objetivo._id.toString(),
      { permisos: ['pqr.ver', 'tareas.ver'] },
      ACTOR,
    );

    expect(m.auditoria.registrar.mock.calls[0][0]).toMatchObject({
      accion: 'actualizar',
      detalle: detalle(['tareas.ver'], ['facturas.ver']),
    });
  });

  it('desactivar: `retirar` y quitadas incluye las claves que daban los roles (S-U8.3)', async () => {
    const ana = cuenta();
    const rolId = new Types.ObjectId();
    const objetivo = fila(ana._id, {
      permisos: ['facturas.ver'],
      roleIds: [rolId],
    });
    const m = montar({
      cuentas: [ana],
      asignaciones: [objetivo],
      roles: [{ _id: rolId, copropiedadId: COP, permisos: ['pqr.ver'] }],
    });

    await m.servicio.actualizar(
      ana._id.toString(),
      objetivo._id.toString(),
      { estado: 'inactivo' },
      ACTOR,
    );

    expect(m.auditoria.registrar.mock.calls[0][0]).toMatchObject({
      accion: 'retirar',
      detalle: detalle([], ['facturas.ver', 'pqr.ver']),
    });
  });

  it('reactivar: `crear`, y los roles viejos no cuentan en "después" (S-U8.4)', async () => {
    const ana = cuenta();
    const rolId = new Types.ObjectId();
    const objetivo = fila(ana._id, {
      estado: 'inactive',
      permisos: ['tareas.ver'],
      roleIds: [rolId],
    });
    const m = montar({
      cuentas: [ana],
      asignaciones: [objetivo],
      roles: [{ _id: rolId, copropiedadId: COP, permisos: ['facturas.ver'] }],
    });

    await m.servicio.actualizar(
      ana._id.toString(),
      objetivo._id.toString(),
      { estado: 'activo', permisos: ['pqr.ver'] },
      ACTOR,
    );

    expect(m.auditoria.registrar.mock.calls[0][0]).toMatchObject({
      accion: 'crear',
      detalle: detalle(['pqr.ver'], []),
    });
  });

  it('reactivar por POST: `crear` con las claves enviadas', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, {
      estado: 'inactive',
      permisos: ['tareas.ver'],
    });
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

    await m.servicio.agregar(
      ana._id.toString(),
      agregarCop(['pqr.ver']),
      ACTOR,
    );

    expect(m.auditoria.registrar.mock.calls[0][0]).toMatchObject({
      accion: 'crear',
      detalle: detalle(['pqr.ver'], []),
    });
  });

  it('una clave heredada no ofrecida nunca aparece en el detalle (S-U8.8)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, { permisos: ['inmuebles.aprobar'] });
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });

    // Re-sending it and adding nothing offered: a no-op, no entry.
    await m.servicio.actualizar(
      ana._id.toString(),
      objetivo._id.toString(),
      { permisos: ['inmuebles.aprobar'] },
      ACTOR,
    );
    expect(m.auditoria.registrar).not.toHaveBeenCalled();

    await m.servicio.actualizar(
      ana._id.toString(),
      objetivo._id.toString(),
      { permisos: ['inmuebles.aprobar', 'pqr.ver'] },
      ACTOR,
    );
    expect(m.auditoria.registrar.mock.calls[0][0]).toMatchObject({
      detalle: detalle(['pqr.ver'], []),
    });
  });

  it('si `registrar` falla, la petición falla y la fila queda como estaba (S-U8.5)', async () => {
    const ana = cuenta();
    const objetivo = fila(ana._id, { permisos: ['facturas.ver'] });
    const m = montar({ cuentas: [ana], asignaciones: [objetivo] });
    const antes = instantanea([objetivo]);
    m.auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));

    await expect(
      m.servicio.actualizar(
        ana._id.toString(),
        objetivo._id.toString(),
        { permisos: ['pqr.ver'] },
        ACTOR,
      ),
    ).rejects.toThrow('sin auditoría');

    expect(m.sesiones[0].deshecha).toBe(true);
    expect(instantanea(m.storeAsig)).toEqual(antes);
  });

  it('si `registrar` falla al agregar, no queda la fila nueva', async () => {
    const ana = cuenta();
    const m = montar({ cuentas: [ana] });
    m.auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));

    await expect(
      m.servicio.agregar(ana._id.toString(), agregarCop(), ACTOR),
    ).rejects.toThrow('sin auditoría');

    expect(m.storeAsig).toHaveLength(0);
  });

  it('toda petición rechazada (400, 403, 404, 409) escribe cero entradas (S-U8.6)', async () => {
    const ana = cuenta();
    const root = cuenta({ esAdministradorPlataforma: true });
    const personal = fila(ana._id, { perfil: 'personal' });
    const activa = fila(ana._id, { copropiedadId: OTRA_COP });
    const m = montar({
      cuentas: [ana, root],
      asignaciones: [personal, activa],
    });

    const rechazadas = [
      () =>
        m.servicio.agregar(
          ana._id.toString(),
          agregarCop(['tareas.volar']),
          ACTOR,
        ),
      () =>
        m.servicio.agregar(
          ana._id.toString(),
          agregarCop(['pqr.ver'], OTRA_COP.toString()),
          ACTOR,
        ),
      () => m.servicio.agregar(root._id.toString(), agregarCop(), ACTOR),
      () => m.servicio.agregar('mal', agregarCop(), ACTOR),
      () =>
        m.servicio.actualizar(
          ana._id.toString(),
          personal._id.toString(),
          { permisos: [] },
          ACTOR,
        ),
      () =>
        m.servicio.actualizar(
          ana._id.toString(),
          'mal',
          { permisos: [] },
          ACTOR,
        ),
      () =>
        m.servicio.actualizar(
          ana._id.toString(),
          activa._id.toString(),
          { permisos: ['x.y'] },
          ACTOR,
        ),
    ];
    for (const intento of rechazadas) {
      await expect(intento()).rejects.toBeInstanceOf(Error);
    }

    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });
});
