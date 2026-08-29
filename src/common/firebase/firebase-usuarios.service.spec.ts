import { ConflictException } from '@nestjs/common';
import type { Auth } from 'firebase-admin/auth';
import { FirebaseUsuariosService } from './firebase-usuarios.service';

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
