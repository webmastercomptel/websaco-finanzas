import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { CaslAbilityFactory } from './casl-ability.factory';
import { PoliciesGuard } from './policies.guard';
import {
  AUTHENTICATED_ONLY_KEY,
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
} from './check-ability.decorator';
import type { RequiredRule } from './check-ability.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/** Reflector stub returning a fixed AND rule set and/or any-of rule set. */
const reflectorWith = (
  rules?: RequiredRule[],
  anyRules?: RequiredRule[],
  authenticatedOnly?: boolean,
): Reflector =>
  ({
    getAllAndOverride: (key: string) =>
      key === CHECK_ABILITY_KEY
        ? rules
        : key === CHECK_ANY_ABILITY_KEY
          ? anyRules
          : key === AUTHENTICATED_ONLY_KEY
            ? authenticatedOnly
            : undefined,
  }) as unknown as Reflector;

/** ExecutionContext stub exposing a request with (or without) a user. */
const contextWith = (user?: IRequestUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

const guardFor = (
  rules?: RequiredRule[],
  anyRules?: RequiredRule[],
  authenticatedOnly?: boolean,
) =>
  new PoliciesGuard(
    reflectorWith(rules, anyRules, authenticatedOnly),
    new CaslAbilityFactory(),
  );

const userWith = (permissions: string[]): IRequestUser => ({
  uid: 'uid-1',
  email: 'contador@ejemplo.com',
  permissions,
});

describe('PoliciesGuard', () => {
  it('deniega una ruta sin @CheckAbility ni @AuthenticatedOnly (default-deny)', () => {
    expect(() =>
      guardFor(undefined).canActivate(contextWith(userWith([]))),
    ).toThrow(ForbiddenException);
  });

  it('deniega cuando la lista de reglas está vacía', () => {
    expect(() => guardFor([]).canActivate(contextWith(userWith([])))).toThrow(
      ForbiddenException,
    );
  });

  it('deja pasar una ruta @AuthenticatedOnly a un usuario sin permisos', () => {
    expect(
      guardFor(undefined, undefined, true).canActivate(
        contextWith(userWith([])),
      ),
    ).toBe(true);
  });

  it('@AuthenticatedOnly sigue exigiendo un usuario autenticado', () => {
    expect(() =>
      guardFor(undefined, undefined, true).canActivate(contextWith()),
    ).toThrow(ForbiddenException);
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

  describe('@CheckAnyAbility (alguna de las reglas)', () => {
    const anyRules: RequiredRule[] = [
      { action: 'create', subject: 'Recibo' },
      { action: 'create', subject: 'NotaCredito' },
    ];

    it('pasa con que el usuario cumpla UNA de las reglas', () => {
      const guard = guardFor(undefined, anyRules);

      expect(guard.canActivate(contextWith(userWith(['recibos.crear'])))).toBe(
        true,
      );
      expect(
        guard.canActivate(contextWith(userWith(['notas-credito.crear']))),
      ).toBe(true);
    });

    it('deniega cuando el usuario no cumple NINGUNA', () => {
      const guard = guardFor(undefined, anyRules);

      expect(() =>
        guard.canActivate(contextWith(userWith(['recibos.ver']))),
      ).toThrow(ForbiddenException);
    });

    it('deniega sin usuario autenticado', () => {
      expect(() =>
        guardFor(undefined, anyRules).canActivate(contextWith()),
      ).toThrow(ForbiddenException);
    });

    it('una lista any-of vacía no concede acceso (default-deny)', () => {
      expect(() =>
        guardFor(undefined, []).canActivate(contextWith(userWith([]))),
      ).toThrow(ForbiddenException);
    });

    it('el administrador de plataforma pasa', () => {
      const root: IRequestUser = {
        uid: 'uid-root',
        email: 'root@ejemplo.com',
        isPlatformAdmin: true,
      };

      expect(guardFor(undefined, anyRules).canActivate(contextWith(root))).toBe(
        true,
      );
    });

    it('combinado con @CheckAbility: exige TODAS las AND y además alguna any-of', () => {
      const guard = guardFor(
        [{ action: 'read', subject: 'Factura' }],
        anyRules,
      );

      expect(() =>
        guard.canActivate(contextWith(userWith(['recibos.crear']))),
      ).toThrow(ForbiddenException);
      expect(() =>
        guard.canActivate(contextWith(userWith(['facturas.ver']))),
      ).toThrow(ForbiddenException);
      expect(
        guard.canActivate(
          contextWith(userWith(['facturas.ver', 'recibos.crear'])),
        ),
      ).toBe(true);
    });

    it('no debilita el AND: @CheckAbility sigue exigiendo todas', () => {
      const guard = guardFor([
        { action: 'create', subject: 'Recibo' },
        { action: 'create', subject: 'NotaCredito' },
      ]);

      expect(() =>
        guard.canActivate(contextWith(userWith(['recibos.crear']))),
      ).toThrow(ForbiddenException);
    });
  });
});

describe('PoliciesGuard — licencia por módulo (@Modulo)', () => {
  const reglas: RequiredRule[] = [{ action: 'read', subject: 'Factura' }];

  /** Reflector stub for a route that declares a module and an ability. */
  const guardConModulo = (modulo?: string) =>
    new PoliciesGuard(
      {
        getAllAndOverride: (key: string) =>
          key === CHECK_ABILITY_KEY
            ? reglas
            : key === MODULO_KEY
              ? modulo
              : undefined,
      } as unknown as Reflector,
      new CaslAbilityFactory(),
    );

  const conModulos = (modulos?: IRequestUser['modulos']): IRequestUser => ({
    ...userWith(['facturas.ver']),
    modulos,
  });

  it('deniega aunque tenga el permiso si la copropiedad no contrató el módulo', () => {
    expect(() =>
      guardConModulo('administracion').canActivate(
        contextWith(conModulos(['finanzas'])),
      ),
    ).toThrow(ForbiddenException);
  });

  it('permite cuando la copropiedad contrató el módulo y el usuario tiene el permiso', () => {
    expect(
      guardConModulo('finanzas').canActivate(
        contextWith(conModulos(['finanzas'])),
      ),
    ).toBe(true);
  });

  it('el administrador de plataforma también está sujeto a la licencia', () => {
    const root: IRequestUser = {
      uid: 'uid-root',
      email: 'root@ejemplo.com',
      isPlatformAdmin: true,
      modulos: ['finanzas'],
    };

    expect(() =>
      guardConModulo('administracion').canActivate(contextWith(root)),
    ).toThrow(ForbiddenException);
  });

  it('sin copropiedad activa (módulos indefinidos) deniega una ruta de módulo', () => {
    expect(() =>
      guardConModulo('finanzas').canActivate(
        contextWith(conModulos(undefined)),
      ),
    ).toThrow(ForbiddenException);
  });

  it('una ruta sin @Modulo no exige licencia (el inventario de rutas exige declararla)', () => {
    expect(
      guardConModulo(undefined).canActivate(contextWith(conModulos(undefined))),
    ).toBe(true);
  });
});
