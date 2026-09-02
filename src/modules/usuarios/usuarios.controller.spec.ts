import { UsuariosController } from './usuarios.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(usuarios: Record<string, unknown>) {
  return new UsuariosController(usuarios as never);
}

const USER: IRequestUser = {
  uid: 'uid-1',
  email: 'admin@comptel.com',
  accountId: 'account-real-1',
  nombre: 'Admin Real',
};

describe('UsuariosController.create', () => {
  it('pasa el accountId/nombre del caller autenticado, nunca del body', async () => {
    const usuarios = { create: jest.fn(() => Promise.resolve({ id: 'u-1' })) };
    const controller = makeController(usuarios);

    await controller.create(
      { nombre: 'Ana', email: 'ana@ejemplo.com', password: 'clave123' },
      USER,
    );

    expect(usuarios.create).toHaveBeenCalledWith(
      { nombre: 'Ana', email: 'ana@ejemplo.com', password: 'clave123' },
      { accountId: 'account-real-1', nombre: 'Admin Real' },
    );
  });

  it('usa el email como respaldo cuando el caller no tiene nombre', async () => {
    const usuarios = { create: jest.fn(() => Promise.resolve({ id: 'u-1' })) };
    const controller = makeController(usuarios);
    const userSinNombre: IRequestUser = { ...USER, nombre: undefined };

    await controller.create(
      { nombre: 'Ana', email: 'ana@ejemplo.com', password: 'clave123' },
      userSinNombre,
    );

    expect(usuarios.create).toHaveBeenCalledWith(
      { nombre: 'Ana', email: 'ana@ejemplo.com', password: 'clave123' },
      { accountId: 'account-real-1', nombre: userSinNombre.email },
    );
  });
});

describe('UsuariosController.update', () => {
  it('pasa el accountId/nombre del caller autenticado, nunca del body', async () => {
    const usuarios = { update: jest.fn(() => Promise.resolve({ id: 'u-1' })) };
    const controller = makeController(usuarios);

    await controller.update('u-1', { estado: 'inactivo' }, USER);

    expect(usuarios.update).toHaveBeenCalledWith(
      'u-1',
      { estado: 'inactivo' },
      { accountId: 'account-real-1', nombre: 'Admin Real' },
    );
  });
});
