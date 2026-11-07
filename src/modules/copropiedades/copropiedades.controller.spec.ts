import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { CopropiedadesController } from './copropiedades.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(copropiedades: Record<string, unknown>) {
  return new CopropiedadesController(copropiedades as never);
}

const USER: IRequestUser = {
  uid: 'uid-1',
  email: 'admin@comptel.com',
  accountId: 'account-real-1',
  nombre: 'Admin Real',
};

describe('CopropiedadesController.create', () => {
  it('pasa el accountId/nombre del caller autenticado, nunca del body', async () => {
    const copropiedades = {
      create: jest.fn(() => Promise.resolve({ id: 'cop-1' })),
    };
    const controller = makeController(copropiedades);

    await controller.create({ nombre: 'Granada' }, USER);

    expect(copropiedades.create).toHaveBeenCalledWith(
      { nombre: 'Granada' },
      { accountId: 'account-real-1', nombre: 'Admin Real' },
    );
  });

  it('usa el email como respaldo cuando el caller no tiene nombre', async () => {
    const copropiedades = {
      create: jest.fn(() => Promise.resolve({ id: 'cop-1' })),
    };
    const controller = makeController(copropiedades);
    const userSinNombre: IRequestUser = { ...USER, nombre: undefined };

    await controller.create({ nombre: 'Granada' }, userSinNombre);

    expect(copropiedades.create).toHaveBeenCalledWith(
      { nombre: 'Granada' },
      { accountId: 'account-real-1', nombre: userSinNombre.email },
    );
  });
});

describe('CopropiedadesController.update', () => {
  it('pasa el accountId/nombre del caller autenticado, nunca del body', async () => {
    const copropiedades = {
      update: jest.fn(() => Promise.resolve({ id: 'cop-1' })),
    };
    const controller = makeController(copropiedades);

    await controller.update('cop-1', { ciudad: 'Medellín' }, USER);

    expect(copropiedades.update).toHaveBeenCalledWith(
      'cop-1',
      { ciudad: 'Medellín' },
      { accountId: 'account-real-1', nombre: 'Admin Real' },
    );
  });
});

describe('CopropiedadesController — solo plataforma cambia modulosContratados', () => {
  it('solo plataforma cambia modulosContratados (403 para administrador de copropiedad)', () => {
    // Las rutas de escritura viven bajo PlatformAdminGuard: se ejecuta el guard
    // REAL contra quien administra una copropiedad (cuenta con permisos, sin
    // bandera de plataforma).
    const guards = Reflect.getMetadata(
      '__guards__',
      CopropiedadesController,
    ) as Array<new () => { canActivate: (c: unknown) => boolean }>;
    const guard = guards.find((g) => g.name === 'PlatformAdminGuard');
    expect(guard).toBeDefined();

    const contexto = (user: Partial<IRequestUser>) => ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    });
    const instancia = new guard!();

    expect(() =>
      instancia.canActivate(
        contexto({
          uid: 'u',
          email: 'a@b.co',
          accountId: 'a',
          permissions: ['facturas.ver'],
        }),
      ),
    ).toThrow(ForbiddenException);
    expect(
      instancia.canActivate(
        contexto({
          uid: 'u',
          email: 'a@b.co',
          accountId: 'a',
          isPlatformAdmin: true,
        }),
      ),
    ).toBe(true);
  });

  it('la ruta PATCH y la de creación pasan el DTO tal cual al servicio', async () => {
    const copropiedades = { update: jest.fn(() => Promise.resolve({})) };
    const controller = makeController(copropiedades);

    await controller.update(
      'cop-1',
      { modulosContratados: ['finanzas'] },
      USER,
    );

    expect(copropiedades.update).toHaveBeenCalledWith(
      'cop-1',
      { modulosContratados: ['finanzas'] },
      expect.anything(),
    );
  });
});
