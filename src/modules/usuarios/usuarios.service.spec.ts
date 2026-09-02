import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { UsuariosService } from './usuarios.service';
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
  fullName: 'Ana Pérez',
  isPlatformAdmin: false,
  status: 'active',
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

const asignacionDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  accountId: new Types.ObjectId(),
  scope: 'copropiedad',
  coPropertyId: new Types.ObjectId(),
  entidadId: null,
  permissions: ['inmuebles.gestionar'],
  status: 'active',
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
  } = {},
) => {
  // A live array, not a snapshot: `create` appends to it, so the service's
  // own re-read via `findOne` after creating finds what it just made — the
  // same way a real collection would.
  const cuentas = [...(opts.cuentas ?? [])];
  const cuentasCreadas: Record<string, unknown>[] = [];
  const asignacionesGuardadas: Record<string, unknown>[] = [];
  const filtrosAccounts: Filtro[] = [];

  const accounts = {
    filtrosAccounts,
    cuentasCreadas,
    exists: jest.fn((filtro: Filtro) => {
      filtrosAccounts.push(filtro);
      return {
        exec: () => Promise.resolve(opts.duplicada ? { _id: 'x' } : null),
      };
    }),
    find: jest.fn(() => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({ exec: () => Promise.resolve(cuentas) }),
        }),
      }),
    })),
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
    findOne: jest.fn(() => ({
      sort: () => ({
        exec: () => Promise.resolve(asignaciones[0] ?? null),
      }),
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      asignacionesGuardadas.push(doc);
      return Promise.resolve(asignacionDoc(doc));
    }),
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

describe('UsuariosService.create', () => {
  it('rechaza un correo local ya usado ANTES de tocar Firebase', async () => {
    // Si Firebase se llamara primero, un correo ya usado localmente crearía
    // una identidad huérfana por cada intento fallido.
    const { accounts, asignacionesModel } = construirModelos({
      duplicada: true,
    });
    const { firebase, crear } = firebaseUsuariosCon();
    const service = new UsuariosService(
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
    const service = new UsuariosService(
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
    const service = new UsuariosService(
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
    const service = new UsuariosService(
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
        permisos: ['inmuebles.gestionar'],
      },
      ACTOR,
    );

    expect(asignacionesModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'copropiedad',
        coPropertyId: copId,
        permissions: ['inmuebles.gestionar'],
      }),
    );
  });

  it('registra la auditoría con el actor autenticado, nunca uno del body', async () => {
    const { accounts, asignacionesModel } = construirModelos();
    const { firebase } = firebaseUsuariosCon();
    const auditoria = mockAuditoria();
    const service = new UsuariosService(
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
    const service = new UsuariosService(
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
    const service = new UsuariosService(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.update(cuenta._id.toString(), { estado: 'inactivo' }, ACTOR);

    expect(establecerHabilitado).toHaveBeenCalledWith('uid-real-1', false);
    expect(cuenta.status).toBe('inactive');
  });

  it('una cuenta pendiente de reclamar no llama a Firebase', async () => {
    // Todavía no hay identidad real que deshabilitar — ver seed-admin.ts. El
    // bloqueo lo sostiene igual el chequeo local del guard.
    const cuenta = cuentaDoc({ firebaseUid: 'pendiente:root@ejemplo.com' });
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
    });
    const { firebase, establecerHabilitado } = firebaseUsuariosCon();
    const service = new UsuariosService(
      accounts as never,
      asignacionesModel as never,
      firebase,
      mockAuditoria() as never,
    );

    await service.update(cuenta._id.toString(), { estado: 'inactivo' }, ACTOR);

    expect(establecerHabilitado).not.toHaveBeenCalled();
    expect(cuenta.status).toBe('inactive');
  });

  it('resetea la contraseña solo cuando se pide', async () => {
    const cuenta = cuentaDoc();
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
    });
    const { firebase, actualizarPassword } = firebaseUsuariosCon();
    const service = new UsuariosService(
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
    const service = new UsuariosService(
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
    const service = new UsuariosService(
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

    expect(anterior.status).toBe('inactive');
    expect(anterior.save).toHaveBeenCalled();
    expect(
      asignacionesGuardadas.some(
        (g) => (g as { coPropertyId?: string }).coPropertyId === nuevaCopId,
      ),
    ).toBe(true);
  });

  it('mismo objetivo: actualiza permisos en la misma fila, sin crear otra', async () => {
    const cuenta = cuentaDoc();
    const copId = new Types.ObjectId();
    const actual = asignacionDoc({
      accountId: cuenta._id,
      coPropertyId: copId,
    });
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
      asignaciones: [actual],
    });
    const { firebase } = firebaseUsuariosCon();
    const service = new UsuariosService(
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
    expect(actual.permissions).toEqual(['facturas.ver']);
    expect(actual.status).toBe('active');
  });

  it('registra la auditoría con el actor autenticado, nunca uno del body', async () => {
    const cuenta = cuentaDoc();
    const { accounts, asignacionesModel } = construirModelos({
      cuentas: [cuenta],
    });
    const { firebase } = firebaseUsuariosCon();
    const auditoria = mockAuditoria();
    const service = new UsuariosService(
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
      entidadEtiqueta: cuenta.fullName,
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
    const service = new UsuariosService(
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
