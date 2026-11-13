import { ConflictException, Logger } from '@nestjs/common';
import type { Auth } from 'firebase-admin/auth';
import { claveCorreo } from '../utils/email.utils';
import { FirebaseUsuariosService } from './firebase-usuarios.service';
import { uidDeResidente } from './uid-residente';

/**
 * Returns the mocks alongside the typed `Auth` double, never read back off
 * it: extracting a method reference from an object typed as a real interface
 * (`expect(auth.createUser)`) is what `@typescript-eslint/unbound-method`
 * warns about, because nothing guarantees a plain object's method keeps its
 * `this` when handled that way — even though these are jest mocks and it is
 * harmless in practice.
 */
const authCon = (opts: { crear?: jest.Mock; actualizar?: jest.Mock } = {}) => {
  const createUser =
    opts.crear ?? jest.fn().mockResolvedValue({ uid: 'uid-nuevo' });
  const updateUser = opts.actualizar ?? jest.fn().mockResolvedValue(undefined);
  return {
    auth: { createUser, updateUser } as unknown as Auth,
    createUser,
    updateUser,
  };
};

describe('FirebaseUsuariosService.crear', () => {
  it('crea la identidad con el correo verificado', async () => {
    // Lo tipeó un administrador que lo está garantizando, no un desconocido
    // reclamando la dirección — no hay flujo de verificación que atravesar.
    const { auth, createUser } = authCon();
    const service = new FirebaseUsuariosService(auth);

    const resultado = await service.crear({
      email: 'nueva@ejemplo.com',
      password: 'clave123',
      nombre: 'Ana Pérez',
    });

    expect(resultado).toEqual({ uid: 'uid-nuevo' });
    expect(createUser).toHaveBeenCalledWith({
      email: 'nueva@ejemplo.com',
      password: 'clave123',
      displayName: 'Ana Pérez',
      emailVerified: true,
    });
  });

  it('convierte el correo duplicado en un error entendible', async () => {
    const { auth } = authCon({
      crear: jest.fn().mockRejectedValue({ code: 'auth/email-already-exists' }),
    });
    const service = new FirebaseUsuariosService(auth);

    await expect(
      service.crear({
        email: 'ya@existe.com',
        password: 'clave123',
        nombre: 'Alguien',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('SEC: el 409 de correo duplicado no lleva la dirección', async () => {
    const { auth } = authCon({
      crear: jest.fn().mockRejectedValue({ code: 'auth/email-already-exists' }),
    });
    const service = new FirebaseUsuariosService(auth);

    const error: unknown = await service
      .crear({ email: 'ya@existe.com', password: 'clave123', nombre: 'X' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    const mensaje = (error as ConflictException).message;
    expect(mensaje).toBe('Ya existe una cuenta de Firebase con ese correo.');
    expect(mensaje).not.toContain('ya@existe.com');
    expect(
      JSON.stringify((error as ConflictException).getResponse()),
    ).not.toContain('ya@existe.com');
  });

  it('deja pasar cualquier otro error tal cual', async () => {
    const { auth } = authCon({
      crear: jest.fn().mockRejectedValue(new Error('fuera de línea')),
    });
    const service = new FirebaseUsuariosService(auth);

    await expect(
      service.crear({
        email: 'x@x.com',
        password: 'clave123',
        nombre: 'X',
      }),
    ).rejects.toThrow('fuera de línea');
  });
});

describe('FirebaseUsuariosService.establecerHabilitado', () => {
  it('deshabilitar es lo que corta el acceso: dispara disabled:true', async () => {
    // Esto es lo que hace inmediato el bloqueo — verifyIdToken con
    // checkRevoked ya rechaza a un usuario deshabilitado sin necesitar
    // revokeRefreshTokens aparte.
    const { auth, updateUser } = authCon();
    const service = new FirebaseUsuariosService(auth);

    await service.establecerHabilitado('uid-1', false);

    expect(updateUser).toHaveBeenCalledWith('uid-1', { disabled: true });
  });

  it('habilitar de nuevo dispara disabled:false', async () => {
    const { auth, updateUser } = authCon();
    const service = new FirebaseUsuariosService(auth);

    await service.establecerHabilitado('uid-1', true);

    expect(updateUser).toHaveBeenCalledWith('uid-1', { disabled: false });
  });
});

describe('FirebaseUsuariosService.actualizarPassword', () => {
  it('actualiza solo la contraseña', async () => {
    const { auth, updateUser } = authCon();
    const service = new FirebaseUsuariosService(auth);

    await service.actualizarPassword('uid-1', 'nueva-clave');

    expect(updateUser).toHaveBeenCalledWith('uid-1', {
      password: 'nueva-clave',
    });
  });
});

describe('FirebaseUsuariosService.crearIdentidadResidente', () => {
  const uid = uidDeResidente('ana@ejemplo.com');

  it('SEC: createUser receives only the uid', async () => {
    const { auth, createUser } = authCon();
    const service = new FirebaseUsuariosService(auth);

    await service.crearIdentidadResidente(uid);

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith({ uid });
    const args = (createUser.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(args)).toEqual(['uid']);
  });

  it('SEC: resident uid carries no address', () => {
    expect(uid).toMatch(/^rc1_[0-9a-f]{64}$/);
    expect(uid).toBe(`rc1_${claveCorreo('ana@ejemplo.com')}`);
    expect(uid).not.toContain('ana');
    expect(uid).not.toContain('ejemplo');
    // The same address in any spelling lands on the same identity.
    expect(uidDeResidente('  ANA@Ejemplo.COM ')).toBe(uid);
  });

  /** An Auth double whose createUser says the uid exists and getUser answers `registro`. */
  const yaExiste = (registro: Record<string, unknown>) => {
    const createUser = jest
      .fn()
      .mockRejectedValue({ code: 'auth/uid-already-exists' });
    const getUser = jest.fn().mockResolvedValue({ uid, ...registro });
    const getUserByEmail = jest.fn();
    return {
      service: new FirebaseUsuariosService({
        createUser,
        getUser,
        getUserByEmail,
      } as unknown as Auth),
      getUser,
      getUserByEmail,
    };
  };

  it('auth/uid-already-exists con una identidad VACÍA (como la que crea este servicio) cuenta como éxito', async () => {
    const { service, getUser, getUserByEmail } = yaExiste({
      providerData: [],
    });

    await expect(service.crearIdentidadResidente(uid)).resolves.toBeUndefined();
    expect(getUser).toHaveBeenCalledWith(uid);
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['con correo', { email: 'otra@ejemplo.com', providerData: [] }],
    ['con contraseña', { passwordHash: 'hash', providerData: [] }],
    [
      'con un proveedor',
      { providerData: [{ providerId: 'password', uid: 'x' }] },
    ],
  ])(
    'SEC: auth/uid-already-exists con una identidad %s se rechaza y el registro no nombra a nadie',
    async (_caso, registro) => {
      const espia = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const { service } = yaExiste(registro);

        await expect(service.crearIdentidadResidente(uid)).rejects.toThrow(
          'Identidad de residente no utilizable',
        );
        const salida = espia.mock.calls.map((c) => c.join(' ')).join(' | ');
        expect(espia).toHaveBeenCalledTimes(1);
        expect(salida).not.toContain(uid);
        expect(salida).not.toContain('ejemplo');
        expect(salida).not.toContain('hash');
      } finally {
        espia.mockRestore();
      }
    },
  );

  it('deja pasar cualquier otro error', async () => {
    const { auth } = authCon({
      crear: jest.fn().mockRejectedValue(new Error('fuera de línea')),
    });
    const service = new FirebaseUsuariosService(auth);

    await expect(service.crearIdentidadResidente(uid)).rejects.toThrow(
      'fuera de línea',
    );
  });

  it('SEC: rechaza un uid que no sea rc1_ + 64 hex, sin llamar a Firebase', async () => {
    const { auth, createUser } = authCon();
    const service = new FirebaseUsuariosService(auth);

    await expect(
      service.crearIdentidadResidente('ana@ejemplo.com'),
    ).rejects.toThrow();
    await expect(service.crearIdentidadResidente('rc1_abc')).rejects.toThrow();
    await expect(service.crearIdentidadResidente('')).rejects.toThrow();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('SEC: nunca consulta por correo', async () => {
    const getUserByEmail = jest.fn();
    const createUser = jest.fn().mockResolvedValue({ uid });
    const service = new FirebaseUsuariosService({
      createUser,
      getUserByEmail,
    } as unknown as Auth);

    await service.crearIdentidadResidente(uid);

    expect(getUserByEmail).not.toHaveBeenCalled();
  });
});
