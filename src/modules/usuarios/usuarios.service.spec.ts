import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { UsuariosService } from './usuarios.service';
import { AsignacionesUsuarioService } from './asignaciones-usuario.service';
import type { FirebaseUsuariosService } from '../../common/firebase/firebase-usuarios.service';

type Filtro = Record<string, unknown>;

const mockAuditoria = () => ({
  registrar: jest.fn().mockResolvedValue(undefined),
});

const ACTOR = { accountId: 'actor-1', nombre: 'Admin Test' };

const cuentaDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  firebaseUid: 'uid-real-1',
  email: 'ana@ejemplo.com',
  nombreCompleto: 'Ana Pérez',
  esAdministradorPlataforma: false,
  estado: 'active',
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

const asignacionDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  accountId: new Types.ObjectId(),
  alcance: 'copropiedad',
  copropiedadId: new Types.ObjectId() as Types.ObjectId | null,
  entidadId: null as Types.ObjectId | null,
  permisos: ['inmuebles.editar'],
  perfil: 'administrativo' as 'administrativo' | 'personal',
  roleIds: [] as Types.ObjectId[],
  estado: 'active',
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

/**
 * A model double shared by all tests. `accounts` and `asignaciones` are
 * independent stores so create/update can be exercised against realistic
 * chains without a database.
 */
const construirModelos = (
  opts: {
    cuentas?: ReturnType<typeof cuentaDoc>[];
    asignaciones?: ReturnType<typeof asignacionDoc>[];
    duplicada?: boolean;
    /** Makes `asignaciones.create` reject with this, e.g. a Mongo E11000. */
    errorAlCrear?: Error;
  } = {},
) => {
  // A live array, not a snapshot: `create` appends to it, so the service's
  // own re-read via `findOne` after creating finds what it just made — the
  // same way a real collection would.
  const cuentas = [...(opts.cuentas ?? [])];
  const cuentasCreadas: Record<string, unknown>[] = [];
  const asignacionesGuardadas: Record<string, unknown>[] = [];
  const filtrosAccounts: Filtro[] = [];
  const filtrosListado: Filtro[] = [];

  const accounts = {
    filtrosAccounts,
    cuentasCreadas,
    exists: jest.fn((filtro: Filtro) => {
      filtrosAccounts.push(filtro);
      // A real collection also knows the accounts created during the test, so
      // a retry after a failed creation meets the existing-email rule.
      const yaCreada = cuentas.some((c) => c.email === filtro.email);
      return {
        exec: () =>
          Promise.resolve(opts.duplicada || yaCreada ? { _id: 'x' } : null),
      };
    }),
    find: jest.fn((filtro?: Filtro) => {
      if (filtro) filtrosListado.push(filtro);
      return {
        sort: () => ({
          skip: () => ({
            limit: () => ({ exec: () => Promise.resolve(cuentas) }),
          }),
        }),
      };
    }),
    filtrosListado,
    countDocuments: jest.fn(() => ({
      exec: () => Promise.resolve(cuentas.length),
    })),
    findById: jest.fn((id: string) => ({
      exec: () =>
        Promise.resolve(cuentas.find((c) => c._id.toString() === id) ?? null),
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      cuentasCreadas.push(doc);
      const creada = cuentaDoc(doc);
      cuentas.push(creada);
      return Promise.resolve(creada);
    }),
  };

  const asignaciones = opts.asignaciones ?? [];
  const asignacionesModel = {
    guardadas: asignacionesGuardadas,
    find: jest.fn(() => ({
      populate: () => ({
        populate: () => ({
          sort: () => ({ exec: () => Promise.resolve(asignaciones) }),
        }),
      }),
    })),
    distinct: jest.fn(() => ({
      exec: () => Promise.resolve(asignaciones.map((a) => a.accountId)),
    })),
    // Filter-aware, like the real collection: `{ estado: 'active' }` is the
    // "newest active row" lookup (chained with `.sort`); anything else is the
    // by-target lookup (`alcance` + `copropiedadId`/`entidadId`), any estado.
    // Both honour `accountId`, so a row of ANOTHER account never matches.
    findOne: jest.fn((filtro: Filtro = {}) => {
      const deLaCuenta = (a: ReturnType<typeof asignacionDoc>) =>
        filtro.accountId === undefined ||
        a.accountId.toString() ===
          (filtro.accountId as Types.ObjectId).toString();
      const buscar = () => {
        if (filtro.estado === 'active') {
          return (
            asignaciones.find((a) => deLaCuenta(a) && a.estado === 'active') ??
            null
          );
        }
        return (
          asignaciones.find(
            (a) =>
              deLaCuenta(a) &&
              a.alcance === filtro.alcance &&
              (filtro.copropiedadId === undefined ||
                a.copropiedadId?.toString() ===
                  (filtro.copropiedadId as Types.ObjectId).toString()) &&
              (filtro.entidadId === undefined ||
                a.entidadId?.toString() ===
                  (filtro.entidadId as Types.ObjectId).toString()),
          ) ?? null
        );
      };
      return {
        sort: () => ({ exec: () => Promise.resolve(buscar()) }),
        exec: () => Promise.resolve(buscar()),
      };
    }),
    // Both call shapes of Mongoose's `create`: one document (the legacy
    // update path) and the array form with options, which is what takes a
    // session (the transactional path).
    create: jest.fn(
      (
        doc: Record<string, unknown> | Record<string, unknown>[],
        _opciones?: { session?: unknown },
      ) => {
        if (opts.errorAlCrear !== undefined) {
          return Promise.reject(opts.errorAlCrear);
        }
        const [uno] = Array.isArray(doc) ? doc : [doc];
        asignacionesGuardadas.push(uno);
        const creada = asignacionDoc(uno);
        // Newest first, like the sorted reads: a later update sees this row.
        asignaciones.unshift(creada);
        return Promise.resolve(Array.isArray(doc) ? [creada] : creada);
      },
    ),
    /** What a rolled-back transaction restores: the rows as they were. */
    instantanea: () => {
      const antes = [...asignaciones];
      const guardadasAntes = [...asignacionesGuardadas];
      return () => {
        asignaciones.length = 0;
        asignaciones.push(...antes);
        asignacionesGuardadas.length = 0;
        asignacionesGuardadas.push(...guardadasAntes);
      };
    },
  };

  return { accounts, asignacionesModel, asignacionesGuardadas };
};

/**
 * Returns the mocks separately from the typed double: reading a method off an
 * object typed as the real `FirebaseUsuariosService` class
 * (`expect(firebase.crear)`) is what `@typescript-eslint/unbound-method`
 * warns about, harmless here but not worth silencing case by case.
 */
const firebaseUsuariosCon = (
  over: {
    crear?: jest.Mock;
    establecerHabilitado?: jest.Mock;
    actualizarPassword?: jest.Mock;
  } = {},
) => {
  const crear =
    over.crear ?? jest.fn().mockResolvedValue({ uid: 'uid-real-nueva' });
  const establecerHabilitado =
    over.establecerHabilitado ?? jest.fn().mockResolvedValue(undefined);
  const actualizarPassword =
    over.actualizarPassword ?? jest.fn().mockResolvedValue(undefined);

  return {
    firebase: {
      crear,
      establecerHabilitado,
      actualizarPassword,
    } as unknown as FirebaseUsuariosService,
    crear,
    establecerHabilitado,
    actualizarPassword,
  };
};

/**
 * The service under test, wired like the module does it: the real
 * `AsignacionesUsuarioService` over the same assignments double, and a
 * connection whose transactions undo what the callback wrote when it throws
 * (what Mongo does, and what makes "the audit failed, no row" observable).
 */
const crearServicio = (
  accounts: never,
  asignacionesModel: never,
  firebase: FirebaseUsuariosService,
  auditoria: never,
  opciones: { destinoExiste?: boolean } = {},
) => {
  // The coproperty and the entity the assignment names: both exist unless the
  // test says otherwise (`findById(...).select().lean().exec()`).
  const modeloDestino = {
    findById: jest.fn(() => ({
      select: () => ({
        lean: () => ({
          exec: () =>
            Promise.resolve(
              opciones.destinoExiste === false ? null : { nombre: 'Destino' },
            ),
        }),
      }),
    })),
  };
  const modelo = asignacionesModel as unknown as {
    instantanea: () => () => void;
  };
  const conexion = {
    startSession: jest.fn(() =>
      Promise.resolve({
        endSession: jest.fn().mockResolvedValue(undefined),
        withTransaction: async (fn: () => Promise<void>) => {
          const deshacer = modelo.instantanea();
          try {
            await fn();
          } catch (error) {
            deshacer();
            throw error;
          }
        },
      }),
    ),
  };
  const asignaciones = new AsignacionesUsuarioService(
    asignacionesModel,
    {} as never,
    {} as never,
    modeloDestino as never,
    modeloDestino as never,
    auditoria,
    conexion as never,
  );
  return new UsuariosService(
    accounts,
    asignacionesModel,
    firebase,
    auditoria,
    asignaciones,
    conexion as never,
  );
};

describe('UsuariosService.create', () => {
  it('rechaza un correo local ya usado ANTES de tocar Firebase', async () => {
    // Si Firebase se llamara primero, un correo ya usado localmente crearía
    // una identidad huérfana por cada intento fallido.
    const { accounts, asignacionesModel } = construirModelos({
      duplicada: true,
    });
    const { firebase, crear } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await expect(
      service.create(
        {
          nombre: 'Ana',
          email: 'ana@ejemplo.com',
          password: 'clave123',
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(crear).not.toHaveBeenCalled();
  });

  it('crea la identidad de Firebase y la cuenta local con el mismo uid', async () => {
    const { accounts, asignacionesModel } = construirModelos();
    const { firebase, crear } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.create(
      {
        nombre: 'Ana Pérez',
        email: 'Ana@Ejemplo.com',
        password: 'clave123',
        esAdministradorPlataforma: true,
      },
      ACTOR,
    );

    expect(crear).toHaveBeenCalledWith({
      email: 'ana@ejemplo.com',
      password: 'clave123',
      nombre: 'Ana Pérez',
    });
    const [cuentaCreada] = accounts.cuentasCreadas;
    expect(cuentaCreada).toMatchObject({
      firebaseUid: 'uid-real-nueva',
      email: 'ana@ejemplo.com',
    });
  });

  it('un administrador de plataforma se crea sin asignación', async () => {
    const { accounts, asignacionesModel } = construirModelos();
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.create(
      {
        nombre: 'Root',
        email: 'root@ejemplo.com',
        password: 'clave123',
        esAdministradorPlataforma: true,
        // Aunque vinieran, un administrador de plataforma no necesita una.
        alcance: 'copropiedad',
        copropiedadId: new Types.ObjectId().toString(),
      },
      ACTOR,
    );

    expect(asignacionesModel.create).not.toHaveBeenCalled();
  });

  it('un usuario normal con alcance crea su asignación', async () => {
    const { accounts, asignacionesModel } = construirModelos();
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );
    const copId = new Types.ObjectId().toString();

    await service.create(
      {
        nombre: 'Ana',
        email: 'ana@ejemplo.com',
        password: 'clave123',
        alcance: 'copropiedad',
        copropiedadId: copId,
        permisos: ['inmuebles.editar'],
      },
      ACTOR,
    );

    expect(asignacionesModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          alcance: 'copropiedad',
          // The tenancy law: stored as an ObjectId, never the raw string —
          // see TenantContextService.resolveCoPropertyId's docblock.
          copropiedadId: new Types.ObjectId(copId),
          permisos: ['inmuebles.editar'],
        }),
      ],
      expect.objectContaining({ session: expect.anything() }),
    );
  });

  it('registra la auditoría con el actor autenticado, nunca uno del body', async () => {
    const { accounts, asignacionesModel } = construirModelos();
    const { firebase } = firebaseUsuariosCon();
    const auditoria = mockAuditoria();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      auditoria as never,
    );

    await service.create(
      {
        nombre: 'Ana Pérez',
        email: 'ana@ejemplo.com',
        password: 'clave123',
        esAdministradorPlataforma: true,
      },
      ACTOR,
    );

    // `create`'s own resolved value is the wrapped Account (with a real
    // `_id`) — `cuentasCreadas` only holds the raw pre-wrap doc, which has
    // none, so the id under test has to come from here.
    const cuentaCreada = await (
      accounts.create.mock.results[0] as {
        value: Promise<{ _id: { toString(): string } }>;
      }
    ).value;

    expect(auditoria.registrar).toHaveBeenCalledWith({
      actorAccountId: ACTOR.accountId,
      actorNombre: ACTOR.nombre,
      accion: 'crear',
      entidadTipo: 'usuario',
      entidadId: cuentaCreada._id.toString(),
      entidadEtiqueta: 'Ana Pérez',
    });
  });

  it('si falla la auditoría, la creación entera falla — nada queda sin rastro', async () => {
    const { accounts, asignacionesModel } = construirModelos();
    const { firebase } = firebaseUsuariosCon();
    const auditoria = {
      registrar: jest.fn().mockRejectedValue(new Error('audit down')),
    };
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      auditoria as never,
    );

    await expect(
      service.create(
        {
          nombre: 'Ana',
          email: 'ana@ejemplo.com',
          password: 'clave123',
          esAdministradorPlataforma: true,
        },
        ACTOR,
      ),
    ).rejects.toThrow('audit down');
  });
});

describe('UsuariosService.update', () => {
  it('desactivar deshabilita la identidad de Firebase', async () => {
    // Esto es lo que hace que "desactivar" sea un bloqueo inmediato y no una
    // formalidad que espera a que expire el token.
    const cuenta = cuentaDoc();
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
    });
    const { firebase, establecerHabilitado } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.update(cuenta._id.toString(), { estado: 'inactivo' }, ACTOR);

    expect(establecerHabilitado).toHaveBeenCalledWith('uid-real-1', false);
    expect(cuenta.estado).toBe('inactive');
  });

  it('una cuenta pendiente de reclamar no llama a Firebase', async () => {
    // Todavía no hay identidad real que deshabilitar — ver seed-admin.ts. El
    // bloqueo lo sostiene igual el chequeo local del guard.
    const cuenta = cuentaDoc({ firebaseUid: 'pendiente:root@ejemplo.com' });
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
    });
    const { firebase, establecerHabilitado } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.update(cuenta._id.toString(), { estado: 'inactivo' }, ACTOR);

    expect(establecerHabilitado).not.toHaveBeenCalled();
    expect(cuenta.estado).toBe('inactive');
  });

  it('resetea la contraseña solo cuando se pide', async () => {
    const cuenta = cuentaDoc();
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
    });
    const { firebase, actualizarPassword } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.update(cuenta._id.toString(), {}, ACTOR);
    expect(actualizarPassword).not.toHaveBeenCalled();

    await service.update(
      cuenta._id.toString(),
      { nuevaPassword: 'otra123' },
      ACTOR,
    );
    expect(actualizarPassword).toHaveBeenCalledWith('uid-real-1', 'otra123');
  });

  it('responde "no existe" para un id que no corresponde a ninguna cuenta', async () => {
    const { accounts, asignacionesModel } = construirModelos();
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await expect(
      service.update(
        new Types.ObjectId().toString(),
        { estado: 'activo' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('solo toca la cuenta: ninguna fila cambia (REQ-X1)', () => {
    /** Three rows of the account (two administrative, one from Equipo), snapshotted. */
    const conTresFilas = () => {
      const cuenta = cuentaDoc();
      const filas = [
        asignacionDoc({ accountId: cuenta._id }),
        asignacionDoc({
          accountId: cuenta._id,
          alcance: 'entidad',
          copropiedadId: null,
          entidadId: new Types.ObjectId(),
          permisos: ['facturas.ver'],
        }),
        asignacionDoc({
          accountId: cuenta._id,
          perfil: 'personal',
          roleIds: [new Types.ObjectId()],
        }),
      ];
      const antes = filas.map((f) => JSON.stringify(f));
      const { accounts, asignacionesModel, asignacionesGuardadas } =
        construirModelos({ cuentas: [cuenta], asignaciones: filas });
      const { firebase, establecerHabilitado } = firebaseUsuariosCon();
      const service = crearServicio(
        accounts as never,
        asignacionesModel as never,
        firebase,
        mockAuditoria() as never,
      );
      const intactas = () =>
        filas.every((f, i) => JSON.stringify(f) === antes[i]) &&
        filas.every((f) => (f.save as jest.Mock).mock.calls.length === 0) &&
        asignacionesGuardadas.length === 0 &&
        asignacionesModel.create.mock.calls.length === 0 &&
        asignacionesModel.findOne.mock.calls.length === 0;
      return { cuenta, service, establecerHabilitado, intactas, filas };
    };

    it('renombrar deja las tres filas idénticas (S-X1.1)', async () => {
      const { cuenta, service, intactas } = conTresFilas();

      await service.update(cuenta._id.toString(), { nombre: 'Ana P.' }, ACTOR);

      expect(cuenta.nombreCompleto).toBe('Ana P.');
      expect(intactas()).toBe(true);
    });

    it('desactivar la cuenta deshabilita Firebase y las filas siguen activas: la cuenta es el interruptor (S-X1.2)', async () => {
      const { cuenta, service, establecerHabilitado, intactas, filas } =
        conTresFilas();

      const usuario = await service.update(
        cuenta._id.toString(),
        { estado: 'inactivo' },
        ACTOR,
      );

      expect(establecerHabilitado).toHaveBeenCalledWith('uid-real-1', false);
      expect(cuenta.estado).toBe('inactive');
      expect(intactas()).toBe(true);
      expect(filas.every((f) => f.estado === 'active')).toBe(true);
      expect(usuario.asignaciones.map((a) => a.estado)).toEqual([
        'activo',
        'activo',
        'activo',
      ]);
    });

    it('la respuesta no trae `asignacion`: asignaciones[] es la única representación (S-X2.1)', async () => {
      const { cuenta, service } = conTresFilas();

      const usuario = await service.findOne(cuenta._id.toString());

      expect(usuario).not.toHaveProperty('asignacion');
      expect(usuario.asignaciones).toHaveLength(3);
    });
  });

  it('registra la auditoría con el actor autenticado, nunca uno del body', async () => {
    const cuenta = cuentaDoc();
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
    });
    const { firebase } = firebaseUsuariosCon();
    const auditoria = mockAuditoria();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      auditoria as never,
    );

    await service.update(cuenta._id.toString(), { estado: 'inactivo' }, ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledWith({
      actorAccountId: ACTOR.accountId,
      actorNombre: ACTOR.nombre,
      accion: 'actualizar',
      entidadTipo: 'usuario',
      entidadId: cuenta._id.toString(),
      entidadEtiqueta: cuenta.nombreCompleto,
    });
  });

  it('si falla la auditoría, la actualización entera falla — nada queda sin rastro', async () => {
    const cuenta = cuentaDoc();
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
    });
    const { firebase } = firebaseUsuariosCon();
    const auditoria = {
      registrar: jest.fn().mockRejectedValue(new Error('audit down')),
    };
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      auditoria as never,
    );

    await expect(
      service.update(cuenta._id.toString(), { estado: 'inactivo' }, ACTOR),
    ).rejects.toThrow('audit down');
  });
});

describe('UsuariosService.create — claves de permiso y perfil', () => {
  const COP = new Types.ObjectId().toString();
  const base = {
    nombre: 'Luis',
    email: 'luis@ejemplo.com',
    password: 'clave123',
    alcance: 'copropiedad' as const,
    copropiedadId: COP,
  };

  const servicio = () => {
    const { accounts, asignacionesModel } = construirModelos();
    const { firebase, crear } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );
    return { service, crear, accounts, asignacionesModel };
  };

  it('rechaza con 400 claves de permiso que no existen en el catálogo, ANTES de tocar Firebase', async () => {
    const { service, crear } = servicio();

    await expect(
      service.create({ ...base, permisos: ['facturas.eliminar'] }, ACTOR),
    ).rejects.toThrow(/facturas\.eliminar/);
    expect(crear).not.toHaveBeenCalled();
  });

  it('la primera asignación es siempre administrativa y conserva sus claves de Finanzas (S-X1.8)', async () => {
    const { service, asignacionesModel } = servicio();

    await service.create({ ...base, permisos: ['facturas.ver'] }, ACTOR);

    expect(asignacionesModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          perfil: 'administrativo',
          permisos: ['facturas.ver'],
        }),
      ],
      expect.anything(),
    );
  });

  it('sin claves se crea una fila administrativa vacía', async () => {
    const { service, asignacionesModel } = servicio();

    await service.create({ ...base, permisos: [] }, ACTOR);

    expect(asignacionesModel.create).toHaveBeenCalledWith(
      [expect.objectContaining({ perfil: 'administrativo', permisos: [] })],
      expect.anything(),
    );
  });
});

describe('UsuariosService.findAll — solo el equipo de la plataforma', () => {
  const servicioCon = (opts: Parameters<typeof construirModelos>[0] = {}) => {
    const { accounts, asignacionesModel } = construirModelos(opts);
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );
    return { service, accounts, asignacionesModel };
  };

  it('deja fuera a quien no es administrador de plataforma ni tiene asignación (propietarios y arrendatarios)', async () => {
    const conAsignacion = new Types.ObjectId();
    const { service, accounts } = servicioCon({
      asignaciones: [asignacionDoc({ accountId: conAsignacion })],
    });

    await service.findAll({ estado: 'todos' } as never);

    const filtro = accounts.filtrosListado[0] as {
      $and: Record<string, unknown>[];
    };
    expect(filtro.$and[0]).toEqual({
      $or: [
        { esAdministradorPlataforma: true },
        { _id: { $in: [conAsignacion] } },
      ],
    });
  });

  it('conserva el filtro de estado y la búsqueda junto a la restricción de equipo', async () => {
    const { service, accounts } = servicioCon();

    await service.findAll({ estado: 'inactivo', buscar: 'ana' } as never);

    const filtro = accounts.filtrosListado[0] as {
      $and: Record<string, unknown>[];
    };
    expect(filtro.$and).toHaveLength(3);
    expect(filtro.$and[1]).toEqual({ estado: 'inactive' });
    expect(filtro.$and[2]).toHaveProperty('$or');
  });

  it('no cuenta como administrador a quien solo tiene asignaciones de personal operativo', async () => {
    const { service, asignacionesModel } = servicioCon();

    await service.findAll({ estado: 'todos' } as never);

    expect(asignacionesModel.distinct).toHaveBeenCalledWith('accountId', {
      perfil: { $ne: 'personal' },
    });
  });
});

describe('UsuariosService — asignaciones[] (lista completa por cuenta)', () => {
  /**
   * An assignments model that honours `accountId: { $in }` and records the
   * query, so "no row leaks into another account's item" is observable. Rows
   * come back in the order given, as the real query's sort would deliver them.
   */
  const modeloPorCuenta = (filas: ReturnType<typeof asignacionDoc>[]) => {
    const consultas: { filtro: Filtro; orden?: unknown }[] = [];
    const modelo = {
      consultas,
      distinct: jest.fn(() => ({
        exec: () => Promise.resolve(filas.map((f) => f.accountId)),
      })),
      find: jest.fn((filtro: Filtro) => {
        const consulta: { filtro: Filtro; orden?: unknown } = { filtro };
        consultas.push(consulta);
        const ids = (
          (filtro.accountId as { $in: Types.ObjectId[] }).$in ?? []
        ).map((i) => i.toString());
        const resultado = filas.filter((f) =>
          ids.includes(f.accountId.toString()),
        );
        const cadena = {
          populate: () => cadena,
          sort: (orden: unknown) => {
            consulta.orden = orden;
            return cadena;
          },
          exec: () => Promise.resolve(resultado),
        };
        return cadena;
      }),
    };
    return modelo;
  };

  const servicioCon = (
    cuentas: ReturnType<typeof cuentaDoc>[],
    filas: ReturnType<typeof asignacionDoc>[],
  ) => {
    const { accounts } = construirModelos({ cuentas });
    const modelo = modeloPorCuenta(filas);
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      modelo as never,
      firebase,
      mockAuditoria() as never,
    );
    return { service, modelo };
  };

  const fila = (
    cuenta: ReturnType<typeof cuentaDoc>,
    over: Record<string, unknown> = {},
  ) => asignacionDoc({ accountId: cuenta._id, ...over });

  it('cada cuenta de la página recibe SU lista y ninguna se filtra a otra (S-U1.4)', async () => {
    const ana = cuentaDoc({ email: 'ana@ejemplo.com' });
    const beto = cuentaDoc({ email: 'beto@ejemplo.com' });
    const root = cuentaDoc({
      email: 'root@ejemplo.com',
      esAdministradorPlataforma: true,
    });
    const deAna1 = fila(ana);
    const deAna2 = fila(ana, { perfil: 'personal' });
    const deBeto = fila(beto, { estado: 'inactive' });
    const { service } = servicioCon(
      [ana, beto, root],
      [deAna1, deAna2, deBeto],
    );

    const { items } = await service.findAll({ estado: 'todos' } as never);

    const porEmail = new Map(items.map((u) => [u.email, u]));
    expect(
      porEmail.get('ana@ejemplo.com')?.asignaciones.map((a) => a.id),
    ).toEqual([deAna1._id.toString(), deAna2._id.toString()]);
    expect(
      porEmail.get('beto@ejemplo.com')?.asignaciones.map((a) => a.id),
    ).toEqual([deBeto._id.toString()]);
    expect(porEmail.get('root@ejemplo.com')?.asignaciones).toEqual([]);
  });

  it('una sola consulta de filas alimenta asignaciones, ordenada por antigüedad y luego por id (S-U1.1)', async () => {
    const ana = cuentaDoc();
    const vieja = fila(ana);
    const nuevaInactiva = fila(ana, { estado: 'inactive' });
    const nuevaActiva = fila(ana, { perfil: 'personal' });
    const { service, modelo } = servicioCon(
      [ana],
      [vieja, nuevaInactiva, nuevaActiva],
    );

    const usuario = await service.findOne(ana._id.toString());

    // The old lookup was active-only; the new one reads every row, once.
    expect(modelo.consultas).toHaveLength(1);
    expect(modelo.consultas[0].filtro).toEqual({
      accountId: { $in: [ana._id] },
    });
    expect(modelo.consultas[0].orden).toEqual({ createdAt: 1, _id: 1 });
    expect(usuario.asignaciones).toHaveLength(3);
  });

  it('la página entera cuesta una sola consulta de filas', async () => {
    const ana = cuentaDoc();
    const beto = cuentaDoc();
    const { service, modelo } = servicioCon(
      [ana, beto],
      [fila(ana), fila(beto)],
    );

    await service.findAll({ estado: 'todos' } as never);

    expect(modelo.find).toHaveBeenCalledTimes(1);
  });

  it('un administrador de plataforma sin filas recibe [] (S-U1.5)', async () => {
    const root = cuentaDoc({ esAdministradorPlataforma: true });
    const { service } = servicioCon([root], []);

    const usuario = await service.findOne(root._id.toString());

    expect(usuario.asignaciones).toEqual([]);
    expect(usuario).not.toHaveProperty('asignacion');
  });

  it('las respuestas de create y update también llevan asignaciones', async () => {
    const ana = cuentaDoc();
    const suya = fila(ana);
    const { service } = servicioCon([ana], [suya]);

    const actualizado = await service.update(
      ana._id.toString(),
      { nombre: 'Ana P.' },
      ACTOR,
    );
    expect(actualizado.asignaciones.map((a) => a.id)).toEqual([
      suya._id.toString(),
    ]);

    const creado = await service.create(
      {
        nombre: 'Nuevo',
        email: 'nuevo@ejemplo.com',
        password: 'clave123',
        esAdministradorPlataforma: true,
      },
      ACTOR,
    );
    expect(creado.asignaciones).toEqual([]);
  });
});

describe('UsuariosService.create — la primera asignación y su auditoría, en una transacción (REQ-U9)', () => {
  const COP = new Types.ObjectId().toString();
  const base = {
    nombre: 'Ana',
    email: 'ana@ejemplo.com',
    password: 'clave123',
    alcance: 'copropiedad' as const,
    copropiedadId: COP,
    permisos: ['facturas.ver'],
  };

  const servicio = (
    opts: Parameters<typeof construirModelos>[0] = {},
    destinoExiste = true,
  ) => {
    const { accounts, asignacionesModel } = construirModelos(opts);
    const { firebase, crear } = firebaseUsuariosCon();
    const auditoria = mockAuditoria();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      auditoria as never,
      { destinoExiste },
    );
    return { service, crear, accounts, asignacionesModel, auditoria };
  };

  it.each([
    ['copropiedad', {}, 'La copropiedad no existe'],
    [
      'entidad',
      {
        alcance: 'entidad' as const,
        copropiedadId: undefined,
        entidadId: COP,
      },
      'La entidad no existe',
    ],
  ])(
    'un destino bien formado que no existe (%s): 404 ANTES de Firebase, sin cuenta ni fila',
    async (_caso, cambio, mensaje) => {
      const { service, crear, accounts, asignacionesModel, auditoria } =
        servicio({}, false);

      const intento = service.create({ ...base, ...cambio }, ACTOR);

      await expect(intento).rejects.toBeInstanceOf(NotFoundException);
      await expect(intento).rejects.toThrow(mensaje);
      expect(crear).not.toHaveBeenCalled();
      expect(accounts.create).not.toHaveBeenCalled();
      expect(asignacionesModel.create).not.toHaveBeenCalled();
      expect(auditoria.registrar).not.toHaveBeenCalled();
    },
  );

  it('un administrador de plataforma no consulta ningún destino', async () => {
    const { service, crear } = servicio({}, false);

    await service.create(
      {
        nombre: 'Root',
        email: 'root@ejemplo.com',
        password: 'clave123',
        esAdministradorPlataforma: true,
      },
      ACTOR,
    );

    expect(crear).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['copropiedad', { copropiedadId: `0x${'a'.repeat(22)}` }],
    [
      'entidad',
      {
        alcance: 'entidad' as const,
        copropiedadId: undefined,
        entidadId: `0x${'a'.repeat(22)}`,
      },
    ],
  ])(
    'un id con prefijo 0x (%s) que llegara al servicio es 400, nunca un 500 ni una llamada a Firebase',
    async (_caso, cambio) => {
      const { service, crear } = servicio();

      await expect(
        service.create({ ...base, ...cambio }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(crear).not.toHaveBeenCalled();
    },
  );

  it('la fila y la entrada comparten la sesión, y la entrada lleva detalle con todas las claves efectivas (S-U9.1)', async () => {
    const { service, asignacionesModel, auditoria, accounts } = servicio();

    await service.create(
      { ...base, permisos: ['pqr.ver', 'facturas.ver'] },
      ACTOR,
    );

    const [, opcionesCreate] = asignacionesModel.create.mock.calls[0] as [
      unknown,
      { session: unknown },
    ];
    const [entrada, sesionAudit] = auditoria.registrar.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(sesionAudit).toBe(opcionesCreate.session);
    const cuentaCreada = await (
      accounts.create.mock.results[0] as {
        value: Promise<{ _id: { toString(): string } }>;
      }
    ).value;
    expect(entrada).toEqual({
      actorAccountId: ACTOR.accountId,
      actorNombre: ACTOR.nombre,
      accion: 'crear',
      entidadTipo: 'usuario',
      entidadId: cuentaCreada._id.toString(),
      entidadEtiqueta: 'Ana',
      detalle: { agregadas: ['facturas.ver', 'pqr.ver'], quitadas: [] },
    });
    expect(asignacionesModel.guardadas).toHaveLength(1);
  });

  it('una lista vacía es un valor real: la entrada lleva detalle con arreglos vacíos', async () => {
    const { service, auditoria } = servicio();

    await service.create({ ...base, permisos: [] }, ACTOR);

    expect(auditoria.registrar.mock.calls[0][0]).toMatchObject({
      detalle: { agregadas: [], quitadas: [] },
    });
  });

  it('un administrador de plataforma sin asignación: ninguna fila y una entrada SIN detalle (S-U9.4)', async () => {
    const { service, asignacionesModel, auditoria } = servicio();

    await service.create(
      {
        nombre: 'Root',
        email: 'root@ejemplo.com',
        password: 'clave123',
        esAdministradorPlataforma: true,
      },
      ACTOR,
    );

    expect(asignacionesModel.create).not.toHaveBeenCalled();
    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    expect(auditoria.registrar.mock.calls[0][0]).not.toHaveProperty('detalle');
  });

  it('si falla la auditoría no queda la fila; la identidad y la cuenta se quedan, inertes, y reintentar choca con el 409 del correo (S-U9.2)', async () => {
    const { service, crear, accounts, asignacionesModel, auditoria } =
      servicio();
    auditoria.registrar.mockRejectedValueOnce(new Error('audit down'));

    await expect(service.create(base, ACTOR)).rejects.toThrow('audit down');

    expect(asignacionesModel.guardadas).toHaveLength(0);
    expect(crear).toHaveBeenCalledTimes(1);
    expect(accounts.create).toHaveBeenCalledTimes(1);

    const reintento = service.create(base, ACTOR);
    await expect(reintento).rejects.toBeInstanceOf(ConflictException);
    await expect(reintento).rejects.toThrow(
      'Ya existe una cuenta local con el correo ana@ejemplo.com',
    );
    expect(crear).toHaveBeenCalledTimes(1);
  });

  it.each([['tareas.volar'], ['inmuebles.aprobar'], ['facturas.gestionar']])(
    'una clave que no está ofrecida (%s): 400 que la nombra, ANTES de cualquier llamada a Firebase (S-U9.3)',
    async (clave) => {
      const { service, crear, accounts, asignacionesModel } = servicio();

      const intento = service.create(
        { ...base, permisos: ['facturas.ver', clave] },
        ACTOR,
      );

      await expect(intento).rejects.toBeInstanceOf(BadRequestException);
      await expect(intento).rejects.toThrow(
        `Permisos que no existen: ${clave}`,
      );
      expect(crear).not.toHaveBeenCalled();
      expect(accounts.create).not.toHaveBeenCalled();
      expect(asignacionesModel.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['sin alcance', { alcance: undefined, copropiedadId: undefined }],
    ['copropiedad sin id', { copropiedadId: undefined }],
    [
      'entidad sin id',
      { alcance: 'entidad' as const, copropiedadId: undefined },
    ],
  ])(
    'un usuario que no es administrador de plataforma, %s: 400 antes de Firebase (S-U9.5)',
    async (_caso, cambio) => {
      const { service, crear, accounts } = servicio();

      await expect(
        service.create({ ...base, ...cambio }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(crear).not.toHaveBeenCalled();
      expect(accounts.create).not.toHaveBeenCalled();
    },
  );

  it('la respuesta lleva la fila recién creada en asignaciones', async () => {
    const { service } = servicio();

    const usuario = await service.create(base, ACTOR);

    expect(usuario.asignaciones).toHaveLength(1);
    expect(usuario.asignaciones[0]).toMatchObject({
      alcance: 'copropiedad',
      permisos: ['facturas.ver'],
      estado: 'activo',
    });
  });

  it('una carrera con la clave única (E11000) responde 409 y no deja entrada', async () => {
    const { service, auditoria } = servicio({
      errorAlCrear: Object.assign(new Error('dup'), { code: 11000 }),
    });

    await expect(service.create(base, ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });
});
