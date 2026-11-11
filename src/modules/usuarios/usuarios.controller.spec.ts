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

describe('UsuariosController.permisosFinanzas', () => {
  it('devuelve las claves reales de Finanzas, sin tocar la base de datos', () => {
    const controller = makeController({});

    const { claves } = controller.permisosFinanzas();

    expect(claves).toContain('facturas.aprobar');
    expect(claves).not.toContain('inmuebles.aprobar');
    expect(claves).toContain('facturas.depurar');
    expect(claves).not.toContain('facturas.gestionar');
    expect(claves).toHaveLength(56);
  });

  it('está declarada antes de `:id`, o la ruta se leería como un id', () => {
    const rutas = Object.getOwnPropertyNames(UsuariosController.prototype);
    expect(rutas.indexOf('permisosFinanzas')).toBeLessThan(
      rutas.indexOf('findOne'),
    );
  });
});
