import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { CaslAbilityFactory } from './casl-ability.factory';
import { PoliciesGuard } from './policies.guard';
import type { RequiredRule } from './check-ability.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/** Reflector stub returning a fixed rule set. */
const reflectorWith = (rules?: RequiredRule[]): Reflector =>
  ({ getAllAndOverride: () => rules }) as unknown as Reflector;

/** ExecutionContext stub exposing a request with (or without) a user. */
const contextWith = (user?: IRequestUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

const guardFor = (rules?: RequiredRule[]) =>
  new PoliciesGuard(reflectorWith(rules), new CaslAbilityFactory());

const userWith = (permissions: string[]): IRequestUser => ({
  uid: 'uid-1',
  email: 'contador@ejemplo.com',
  permissions,
});

describe('PoliciesGuard', () => {
  it('deja pasar una ruta sin @CheckAbility', () => {
    expect(guardFor(undefined).canActivate(contextWith())).toBe(true);
  });

  it('deja pasar cuando la lista de reglas está vacía', () => {
    expect(guardFor([]).canActivate(contextWith())).toBe(true);
  });

  it('deniega una ruta protegida sin usuario autenticado', () => {
    // Esto es lo que hace seguro cablear el guard antes de que exista el guard
    // de autenticación: falla cerrado en vez de correr sin identidad.
    const guard = guardFor([{ action: 'read', subject: 'Factura' }]);

    expect(() => guard.canActivate(contextWith())).toThrow(ForbiddenException);
  });

  it('permite cuando el usuario tiene el permiso exigido', () => {
    const guard = guardFor([{ action: 'annul', subject: 'Factura' }]);

    expect(guard.canActivate(contextWith(userWith(['facturas.anular'])))).toBe(
      true,
    );
  });

  it('deniega cuando al usuario le falta el permiso exigido', () => {
    const guard = guardFor([{ action: 'annul', subject: 'Factura' }]);

    expect(() =>
      guard.canActivate(contextWith(userWith(['facturas.ver']))),
    ).toThrow(ForbiddenException);
  });

  it('exige TODAS las reglas declaradas, no alguna', () => {
    const guard = guardFor([
      { action: 'create', subject: 'NotaCredito' },
      { action: 'approve', subject: 'NotaCredito' },
    ]);

    expect(() =>
      guard.canActivate(contextWith(userWith(['notas-credito.crear']))),
    ).toThrow(ForbiddenException);

    expect(
      guard.canActivate(
        contextWith(userWith(['notas-credito.crear', 'notas-credito.aprobar'])),
      ),
    ).toBe(true);
  });

  it('el administrador de plataforma pasa cualquier regla', () => {
    const guard = guardFor([{ action: 'annul', subject: 'Factura' }]);
    const root: IRequestUser = {
      uid: 'uid-root',
      email: 'root@ejemplo.com',
      isPlatformAdmin: true,
    };

    expect(guard.canActivate(contextWith(root))).toBe(true);
  });
});
