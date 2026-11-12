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

  it('cambiar de objetivo retira la asignación anterior, no la borra', async () => {
    // La misma ley de auditoría que en todos lados: "quién podía tocar este
    // edificio en marzo" tiene que seguir siendo respondible.
    const cuenta = cuentaDoc();
    const anterior = asignacionDoc({ accountId: cuenta._id });
    const { accounts, asignacionesModel, asignacionesGuardadas } =
      construirModelos({ cuentas: [cuenta], asignaciones: [anterior] });
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );
    const nuevaCopId = new Types.ObjectId().toString();

    await service.update(
      cuenta._id.toString(),
      {
        alcance: 'copropiedad',
        copropiedadId: nuevaCopId,
      },
      ACTOR,
    );

    expect(anterior.estado).toBe('inactive');
    expect(anterior.save).toHaveBeenCalled();
    expect(
      asignacionesGuardadas.some(
        (g) =>
          (
            g as { copropiedadId?: Types.ObjectId }
          ).copropiedadId?.toString() === nuevaCopId,
      ),
    ).toBe(true);
  });

  it('mismo objetivo: actualiza permisos en la misma fila, sin crear otra', async () => {
    const cuenta = cuentaDoc();
    const copId = new Types.ObjectId();
    const actual = asignacionDoc({
      accountId: cuenta._id,
      copropiedadId: copId,
    });
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
      asignaciones: [actual],
    });
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.update(
      cuenta._id.toString(),
      {
        alcance: 'copropiedad',
        copropiedadId: copId.toString(),
        permisos: ['facturas.ver'],
      },
      ACTOR,
    );

    expect(asignacionesModel.create).not.toHaveBeenCalled();
    expect(actual.permisos).toEqual(['facturas.ver']);
    expect(actual.estado).toBe('active');
  });

  describe('cambio de objetivo con filas previas (índice único ignora el estado)', () => {
    const servicioCon = (
      opts: Parameters<typeof construirModelos>[0],
    ): {
      service: UsuariosService;
      asignacionesModel: ReturnType<
        typeof construirModelos
      >['asignacionesModel'];
    } => {
      const { accounts, asignacionesModel } = construirModelos(opts);
      const { firebase } = firebaseUsuariosCon();
      return {
        service: crearServicio(
          accounts as never,
          asignacionesModel as never,
          firebase,
          mockAuditoria() as never,
        ),
        asignacionesModel,
      };
    };

    it('A → B → A reactiva la fila vieja de A: queda A activa, B inactiva, sin crear otra A', async () => {
      const cuenta = cuentaDoc();
      const copA = new Types.ObjectId();
      const copB = new Types.ObjectId();
      const filaA = asignacionDoc({
        accountId: cuenta._id,
        copropiedadId: copA,
      });
      const filas = [filaA];
      const { service, asignacionesModel } = servicioCon({
        cuentas: [cuenta],
        asignaciones: filas,
      });

      await service.update(
        cuenta._id.toString(),
        { alcance: 'copropiedad', copropiedadId: copB.toString() },
        ACTOR,
      );
      await service.update(
        cuenta._id.toString(),
        { alcance: 'copropiedad', copropiedadId: copA.toString() },
        ACTOR,
      );

      const filaB = filas.find(
        (f) => f.copropiedadId?.toString() === copB.toString(),
      );
      expect(filaA.estado).toBe('active');
      expect(filaB?.estado).toBe('inactive');
      // Only B was ever created; going back to A reused the existing row.
      expect(asignacionesModel.create).toHaveBeenCalledTimes(1);
      expect(filas.filter((f) => f.estado === 'active')).toEqual([filaA]);
    });

    it('un objetivo con fila inactiva previa (p. ej. creada en Equipo) se reactiva con los permisos nuevos', async () => {
      const cuenta = cuentaDoc();
      const copActual = new Types.ObjectId();
      const copDestino = new Types.ObjectId();
      const rolViejo = new Types.ObjectId();
      const actual = asignacionDoc({
        accountId: cuenta._id,
        copropiedadId: copActual,
      });
      const inactiva = asignacionDoc({
        accountId: cuenta._id,
        copropiedadId: copDestino,
        estado: 'inactive',
        perfil: 'personal',
        permisos: ['pqr.ver'],
        roleIds: [rolViejo],
      });
      const { service, asignacionesModel } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual, inactiva],
      });

      await service.update(
        cuenta._id.toString(),
        {
          alcance: 'copropiedad',
          copropiedadId: copDestino.toString(),
          perfil: 'administrativo',
          permisos: ['facturas.ver'],
        },
        ACTOR,
      );

      expect(asignacionesModel.create).not.toHaveBeenCalled();
      // The reused row is a different document from the one being retired.
      expect(inactiva._id.equals(actual._id)).toBe(false);
      expect(inactiva.estado).toBe('active');
      expect(inactiva.permisos).toEqual(['facturas.ver']);
      expect(inactiva.perfil).toBe('administrativo');
      // A new grant never inherits roles from an earlier, retired one.
      expect(inactiva.roleIds).toEqual([]);
      expect(inactiva.save).toHaveBeenCalled();
      expect(actual.estado).toBe('inactive');
    });

    it('un objetivo de alcance entidad con fila inactiva previa también se reactiva', async () => {
      const cuenta = cuentaDoc();
      const entidad = new Types.ObjectId();
      const actual = asignacionDoc({ accountId: cuenta._id });
      const inactiva = asignacionDoc({
        accountId: cuenta._id,
        alcance: 'entidad',
        copropiedadId: null,
        entidadId: entidad,
        estado: 'inactive',
      });
      const { service, asignacionesModel } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual, inactiva],
      });

      await service.update(
        cuenta._id.toString(),
        { alcance: 'entidad', entidadId: entidad.toString() },
        ACTOR,
      );

      expect(asignacionesModel.create).not.toHaveBeenCalled();
      expect(inactiva._id.equals(actual._id)).toBe(false);
      expect(inactiva.estado).toBe('active');
      expect(inactiva.alcance).toBe('entidad');
      expect(actual.estado).toBe('inactive');
    });

    it('si el alta del nuevo objetivo choca con la clave única (carrera): 409 y la fila actual sigue activa', async () => {
      const cuenta = cuentaDoc();
      const actual = asignacionDoc({ accountId: cuenta._id });
      const { service } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual],
        errorAlCrear: Object.assign(new Error('E11000 duplicate key'), {
          code: 11000,
        }),
      });

      await expect(
        service.update(
          cuenta._id.toString(),
          {
            alcance: 'copropiedad',
            copropiedadId: new Types.ObjectId().toString(),
          },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(actual.estado).toBe('active');
      expect(actual.save).not.toHaveBeenCalled();
    });

    it('el mismo destino con el id en mayúsculas es el mismo objetivo: edita en sitio y la fila sigue activa', async () => {
      // @IsMongoId acepta hexadecimal en mayúsculas; comparar cadenas lo
      // trataba como otro destino y dejaba a la cuenta sin fila activa.
      const cuenta = cuentaDoc();
      const copId = new Types.ObjectId();
      const roleId = new Types.ObjectId();
      const actual = asignacionDoc({
        accountId: cuenta._id,
        copropiedadId: copId,
        roleIds: [roleId],
      });
      const { service, asignacionesModel } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual],
      });

      await service.update(
        cuenta._id.toString(),
        {
          alcance: 'copropiedad',
          copropiedadId: copId.toString().toUpperCase(),
          permisos: ['facturas.ver'],
        },
        ACTOR,
      );

      expect(asignacionesModel.create).not.toHaveBeenCalled();
      expect(actual.estado).toBe('active');
      expect(actual.permisos).toEqual(['facturas.ver']);
      // Same-target edit: roles are untouched, as in the lowercase path.
      expect(actual.roleIds).toEqual([roleId]);
    });

    it('el mismo destino de alcance entidad con el id en mayúsculas también edita en sitio', async () => {
      const cuenta = cuentaDoc();
      const entidad = new Types.ObjectId();
      const actual = asignacionDoc({
        accountId: cuenta._id,
        alcance: 'entidad',
        copropiedadId: null,
        entidadId: entidad,
      });
      const { service, asignacionesModel } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual],
      });

      await service.update(
        cuenta._id.toString(),
        { alcance: 'entidad', entidadId: entidad.toString().toUpperCase() },
        ACTOR,
      );

      expect(asignacionesModel.create).not.toHaveBeenCalled();
      expect(actual.estado).toBe('active');
    });

    it('si la búsqueda por destino devuelve la propia fila actual, no la retira', async () => {
      // Segunda defensa: aunque la comparación de ids fallara, la fila que se
      // acaba de escribir activa nunca se desactiva a continuación.
      const cuenta = cuentaDoc();
      const actual = asignacionDoc({ accountId: cuenta._id });
      const { service, asignacionesModel } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual],
      });
      asignacionesModel.findOne
        .mockImplementationOnce(
          // First call: the "newest active row" lookup, as usual.
          () =>
            ({
              sort: () => ({ exec: () => Promise.resolve(actual) }),
            }) as never,
        )
        .mockImplementationOnce(
          // Second call: the by-target lookup answers with the same row.
          () => ({ exec: () => Promise.resolve(actual) }) as never,
        );

      await service.update(
        cuenta._id.toString(),
        {
          alcance: 'copropiedad',
          copropiedadId: new Types.ObjectId().toString(),
          permisos: ['facturas.ver'],
        },
        ACTOR,
      );

      expect(asignacionesModel.create).not.toHaveBeenCalled();
      expect(actual.estado).toBe('active');
    });

    it('si el destino ya tiene otra fila ACTIVA (p. ej. de Equipo): 409, no se reescribe nada y la actual sigue activa', async () => {
      const cuenta = cuentaDoc();
      const copActual = new Types.ObjectId();
      const copDestino = new Types.ObjectId();
      const roleId = new Types.ObjectId();
      const actual = asignacionDoc({
        accountId: cuenta._id,
        copropiedadId: copActual,
      });
      const deEquipo = asignacionDoc({
        accountId: cuenta._id,
        copropiedadId: copDestino,
        perfil: 'personal',
        permisos: ['pqr.ver'],
        roleIds: [roleId],
      });
      const { service, asignacionesModel } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual, deEquipo],
      });

      await expect(
        service.update(
          cuenta._id.toString(),
          {
            alcance: 'copropiedad',
            copropiedadId: copDestino.toString(),
            perfil: 'administrativo',
            permisos: ['facturas.ver'],
          },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(asignacionesModel.create).not.toHaveBeenCalled();
      expect(deEquipo.save).not.toHaveBeenCalled();
      expect(actual.save).not.toHaveBeenCalled();
      expect(actual.estado).toBe('active');
      expect(deEquipo.estado).toBe('active');
      expect(deEquipo.permisos).toEqual(['pqr.ver']);
      expect(deEquipo.perfil).toBe('personal');
      expect(deEquipo.roleIds).toEqual([roleId]);
    });

    it('una fila de otra cuenta para el mismo destino no cuenta como existente', async () => {
      const cuenta = cuentaDoc();
      const copDestino = new Types.ObjectId();
      const actual = asignacionDoc({ accountId: cuenta._id });
      const ajena = asignacionDoc({
        accountId: new Types.ObjectId(),
        copropiedadId: copDestino,
        estado: 'inactive',
      });
      const { service, asignacionesModel } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual, ajena],
      });

      await service.update(
        cuenta._id.toString(),
        { alcance: 'copropiedad', copropiedadId: copDestino.toString() },
        ACTOR,
      );

      expect(asignacionesModel.create).toHaveBeenCalledTimes(1);
      expect(ajena.estado).toBe('inactive');
      expect(ajena.save).not.toHaveBeenCalled();
    });

    it('un error de escritura que no es clave duplicada se propaga y deja activa la fila actual', async () => {
      const cuenta = cuentaDoc();
      const actual = asignacionDoc({ accountId: cuenta._id });
      const { service } = servicioCon({
        cuentas: [cuenta],
        asignaciones: [actual],
        errorAlCrear: new Error('mongo caído'),
      });

      await expect(
        service.update(
          cuenta._id.toString(),
          {
            alcance: 'copropiedad',
            copropiedadId: new Types.ObjectId().toString(),
          },
          ACTOR,
        ),
      ).rejects.toThrow('mongo caído');

      expect(actual.estado).toBe('active');
      expect(actual.save).not.toHaveBeenCalled();
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

describe('UsuariosService — claves de permiso: solo se rechazan las desconocidas', () => {
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

  it('el personal puede recibir claves de Finanzas: el perfil solo dice quién gestiona la fila', async () => {
    const { service, crear, asignacionesModel } = servicio();

    await service.create(
      { ...base, perfil: 'personal', permisos: ['facturas.ver', 'pqr.ver'] },
      ACTOR,
    );

    expect(crear).toHaveBeenCalledTimes(1);
    expect(asignacionesModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          perfil: 'personal',
          permisos: ['facturas.ver', 'pqr.ver'],
        }),
      ],
      expect.anything(),
    );
  });

  it('rechaza con 400 claves de permiso que no existen en el catálogo, ANTES de tocar Firebase', async () => {
    const { service, crear } = servicio();

    await expect(
      service.create({ ...base, permisos: ['facturas.eliminar'] }, ACTOR),
    ).rejects.toThrow(/facturas\.eliminar/);
    expect(crear).not.toHaveBeenCalled();
  });

  it('lo mismo con perfil personal: una clave desconocida es 400 y no crea nada', async () => {
    const { service, crear, asignacionesModel } = servicio();

    await expect(
      service.create(
        { ...base, perfil: 'personal', permisos: ['facturas.gestionar'] },
        ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(crear).not.toHaveBeenCalled();
    expect(asignacionesModel.create).not.toHaveBeenCalled();
  });

  it('actualizar el mismo destino de una fila personal con claves de Finanzas las guarda', async () => {
    const cuenta = cuentaDoc();
    const copId = new Types.ObjectId();
    const actual = asignacionDoc({
      accountId: cuenta._id,
      copropiedadId: copId,
      perfil: 'personal',
      permisos: ['pqr.ver'],
    });
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
      asignaciones: [actual],
    });
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.update(
      cuenta._id.toString(),
      {
        alcance: 'copropiedad',
        copropiedadId: copId.toString(),
        permisos: ['facturas.ver', 'pqr.ver'],
      },
      ACTOR,
    );

    expect(actual.perfil).toBe('personal');
    expect(actual.permisos).toEqual(['facturas.ver', 'pqr.ver']);
    expect(asignacionesModel.create).not.toHaveBeenCalled();
  });

  it('actualizar con una clave desconocida es 400 antes de tocar la cuenta', async () => {
    const cuenta = cuentaDoc();
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
      asignaciones: [],
    });
    const { firebase, establecerHabilitado } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await expect(
      service.update(
        cuenta._id.toString(),
        {
          estado: 'inactivo',
          perfil: 'personal',
          permisos: ['facturas.gestionar'],
        },
        ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(establecerHabilitado).not.toHaveBeenCalled();
    expect(cuenta.save).not.toHaveBeenCalled();
  });

  it('una fila con una clave heredada desconocida sigue pudiendo guardarse sin reenviar permisos', async () => {
    // Stored keys are never judged: only what the request itself sends.
    const cuenta = cuentaDoc();
    const copId = new Types.ObjectId();
    const actual = asignacionDoc({
      accountId: cuenta._id,
      copropiedadId: copId,
      permisos: ['facturas.gestionar', 'facturas.ver'],
    });
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
      asignaciones: [actual],
    });
    const { firebase } = firebaseUsuariosCon();
    const service = crearServicio(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.update(
      cuenta._id.toString(),
      {
        alcance: 'copropiedad',
        copropiedadId: copId.toString(),
        perfil: 'personal',
      },
      ACTOR,
    );

    expect(actual.perfil).toBe('personal');
    expect(actual.permisos).toEqual(['facturas.gestionar', 'facturas.ver']);
  });

  it('un perfil administrativo conserva sus permisos de finanzas', async () => {
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

  it('el personal sin permisos de finanzas se crea con su perfil', async () => {
    const { service, asignacionesModel } = servicio();

    await service.create({ ...base, perfil: 'personal', permisos: [] }, ACTOR);

    expect(asignacionesModel.create).toHaveBeenCalledWith(
      [expect.objectContaining({ perfil: 'personal', permisos: [] })],
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

  it('una sola consulta de filas alimenta asignacion y asignaciones, ordenada por antigüedad y luego por id (S-U1.1)', async () => {
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
    // `asignacion` stays the newest ACTIVE row of any profile.
    expect(usuario.asignacion?.perfil).toBe('personal');
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

  it('un administrador de plataforma sin filas recibe [] y asignacion null (S-U1.5)', async () => {
    const root = cuentaDoc({ esAdministradorPlataforma: true });
    const { service } = servicioCon([root], []);

    const usuario = await service.findOne(root._id.toString());

    expect(usuario.asignaciones).toEqual([]);
    expect(usuario.asignacion).toBeNull();
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
