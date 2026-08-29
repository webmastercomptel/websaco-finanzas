import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';
import type { IRequestUser } from '../interfaces/request-user.interface';

const contextWith = (user?: IRequestUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe('PlatformAdminGuard', () => {
  it('deja pasar al administrador de plataforma', () => {
    const guard = new PlatformAdminGuard();
    const admin: IRequestUser = {
      uid: 'uid-1',
      email: 'root@ejemplo.com',
      isPlatformAdmin: true,
    };

    expect(guard.canActivate(contextWith(admin))).toBe(true);
  });

  it('rechaza a un usuario autenticado que no es administrador de plataforma', () => {
    // Esto es lo que impide que un administrador de una copropiedad, por
    // senior que sea, edite el catálogo de entidades o copropiedades: ese
    // catálogo existe por encima de cualquier edificio al que esté asignado.
    const guard = new PlatformAdminGuard();
    const administradorDeEdificio: IRequestUser = {
      uid: 'uid-2',
      email: 'admin@edificio.com',
      isPlatformAdmin: false,
      permissions: ['inmuebles.gestionar'],
    };

    expect(() =>
      guard.canActivate(contextWith(administradorDeEdificio)),
    ).toThrow(ForbiddenException);
  });

  it('rechaza cuando no hay usuario en la petición', () => {
    const guard = new PlatformAdminGuard();

    expect(() => guard.canActivate(contextWith())).toThrow(ForbiddenException);
  });
});
