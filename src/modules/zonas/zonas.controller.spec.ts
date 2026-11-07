import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ZonasController } from './zonas.controller';

/** The ability a handler declares, read from the same metadata the guard reads. */
const reglasDe = (handler: keyof ZonasController): RequiredRule[] =>
  Reflect.getMetadata(
    CHECK_ABILITY_KEY,
    // Only the function object is read for its metadata; it is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    ZonasController.prototype[handler],
  ) as RequiredRule[];

describe('ZonasController — política de acceso', () => {
  it('cuelga de zonas-comunes (la ruta del sistema original)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ZonasController)).toBe(
      'zonas-comunes',
    );
  });

  // Decisión de seguridad: ver (read) no basta para tocar nada.
  it.each([
    ['listar', 'read'],
    ['crear', 'manage'],
    ['actualizar', 'manage'],
    ['eliminar', 'manage'],
    ['iniciarSubidaImagen', 'manage'],
    ['confirmarImagen', 'manage'],
  ] as const)('%s exige la acción %s sobre Zona', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Zona' }]);
  });

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, ZonasController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, ZonasController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it('expone exactamente las rutas del original, ninguna más', () => {
    const rutas = Object.getOwnPropertyNames(ZonasController.prototype)
      .filter((n) => n !== 'constructor')
      .map((n): [string, object] => [
        n,
        (ZonasController.prototype as unknown as Record<string, object>)[n],
      ])
      .filter(
        ([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined,
      )
      .map(([n]) => n)
      .sort();
    expect(rutas).toEqual([
      'actualizar',
      'confirmarImagen',
      'crear',
      'eliminar',
      'iniciarSubidaImagen',
      'listar',
    ]);
  });
});

describe('ZonasController — el PoliciesGuard real sobre las rutas reales', () => {
  const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

  const contexto = (
    handler: keyof ZonasController,
    permissions: string[],
  ): ExecutionContext => {
    const user: IRequestUser = {
      uid: 'u',
      email: 'a@b.co',
      permissions,
      modulos: ['administracion'],
    };
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      // Only the function object is read for its metadata; it is never called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => ZonasController.prototype[handler],
      getClass: () => ZonasController,
    } as unknown as ExecutionContext;
  };

  const escrituras = [
    'crear',
    'actualizar',
    'eliminar',
    'iniciarSubidaImagen',
    'confirmarImagen',
  ] as const;

  it('zonas.ver permite listar', () => {
    expect(guard.canActivate(contexto('listar', ['zonas.ver']))).toBe(true);
  });

  it.each(escrituras)('zonas.ver NO permite %s', (handler) => {
    expect(() => guard.canActivate(contexto(handler, ['zonas.ver']))).toThrow(
      ForbiddenException,
    );
  });

  it.each(['listar', ...escrituras] as const)(
    'zonas.gestionar permite %s',
    (handler) => {
      expect(guard.canActivate(contexto(handler, ['zonas.gestionar']))).toBe(
        true,
      );
    },
  );

  it.each(['listar', ...escrituras] as const)(
    'un residente sin permisos no entra a %s',
    (handler) => {
      expect(() => guard.canActivate(contexto(handler, []))).toThrow(
        ForbiddenException,
      );
    },
  );

  it.each(['listar', ...escrituras] as const)(
    'reservas.aprobar no abre las zonas (%s)',
    (handler) => {
      expect(() =>
        guard.canActivate(contexto(handler, ['reservas.aprobar'])),
      ).toThrow(ForbiddenException);
    },
  );

  it('niega si la copropiedad no contrató el módulo administracion', () => {
    const user: IRequestUser = {
      uid: 'u',
      email: 'a@b.co',
      permissions: ['zonas.gestionar'],
      modulos: ['finanzas'],
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => ZonasController.prototype.crear,
      getClass: () => ZonasController,
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
