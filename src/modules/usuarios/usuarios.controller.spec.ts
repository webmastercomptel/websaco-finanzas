import { UsuariosController } from './usuarios.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(
  usuarios: Record<string, unknown>,
  asignacionesUsuario: Record<string, unknown> = {},
) {
  return new UsuariosController(
    usuarios as never,
    asignacionesUsuario as never,
  );
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

describe('UsuariosController — asignaciones de una cuenta', () => {
  const USUARIO = { id: 'u-1', asignaciones: [{ id: 'a-1' }] };

  it('POST /:id/asignaciones delega con el actor autenticado y devuelve el Usuario completo', async () => {
    const calls: string[] = [];
    const asignacionesUsuario = {
      agregar: jest.fn(() => {
        calls.push('agregar');
        return Promise.resolve();
      }),
    };
    const usuarios = {
      findOne: jest.fn(() => {
        calls.push('findOne');
        return Promise.resolve(USUARIO);
      }),
    };
    const controller = makeController(usuarios, asignacionesUsuario);
    const dto = {
      alcance: 'copropiedad' as const,
      copropiedadId: 'c-1',
      permisos: ['facturas.ver'],
    };

    const respuesta = await controller.agregarAsignacion('u-1', dto, USER);

    expect(asignacionesUsuario.agregar).toHaveBeenCalledWith('u-1', dto, {
      accountId: 'account-real-1',
      nombre: 'Admin Real',
    });
    expect(usuarios.findOne).toHaveBeenCalledWith('u-1');
    // The response is read AFTER the write, so it carries the new row.
    expect(calls).toEqual(['agregar', 'findOne']);
    expect(respuesta).toBe(USUARIO);
  });

  it('PATCH /:id/asignaciones/:asignacionId delega con ambos ids y devuelve el Usuario completo', async () => {
    const calls: string[] = [];
    const asignacionesUsuario = {
      actualizar: jest.fn(() => {
        calls.push('actualizar');
        return Promise.resolve();
      }),
    };
    const usuarios = {
      findOne: jest.fn(() => {
        calls.push('findOne');
        return Promise.resolve(USUARIO);
      }),
    };
    const controller = makeController(usuarios, asignacionesUsuario);

    const respuesta = await controller.actualizarAsignacion(
      'u-1',
      'a-1',
      { estado: 'inactivo' },
      { ...USER, nombre: undefined },
    );

    expect(asignacionesUsuario.actualizar).toHaveBeenCalledWith(
      'u-1',
      'a-1',
      { estado: 'inactivo' },
      { accountId: 'account-real-1', nombre: USER.email },
    );
    expect(calls).toEqual(['actualizar', 'findOne']);
    expect(respuesta).toBe(USUARIO);
  });

  it('un rechazo del servicio se propaga y no se lee el Usuario', async () => {
    const asignacionesUsuario = {
      agregar: jest.fn(() => Promise.reject(new Error('409'))),
    };
    const usuarios = { findOne: jest.fn() };
    const controller = makeController(usuarios, asignacionesUsuario);

    await expect(
      controller.agregarAsignacion(
        'u-1',
        { alcance: 'entidad', entidadId: 'e-1', permisos: [] },
        USER,
      ),
    ).rejects.toThrow('409');
    expect(usuarios.findOne).not.toHaveBeenCalled();
  });
});
