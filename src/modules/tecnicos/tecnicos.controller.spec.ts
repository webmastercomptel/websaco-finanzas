import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { TecnicosController } from './tecnicos.controller';

const metadato = (key: string, handler: keyof TecnicosController) =>
  Reflect.getMetadata(
    key,
    // Only the function object is read for its metadata; it is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    TecnicosController.prototype[handler],
  ) as RequiredRule[] | undefined;

describe('TecnicosController — política de acceso', () => {
  it('cuelga de tecnicos (la ruta del sistema original)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TecnicosController)).toBe(
      'tecnicos',
    );
  });

  it('el listado acepta read Pqr, read Mantenimiento O manage Tecnico (no hay tecnicos.ver) y no exige nada más', () => {
    expect(metadato(CHECK_ANY_ABILITY_KEY, 'listar')).toEqual([
      { action: 'read', subject: 'Pqr' },
      { action: 'read', subject: 'Mantenimiento' },
      { action: 'manage', subject: 'Tecnico' },
    ]);
    expect(metadato(CHECK_ABILITY_KEY, 'listar')).toBeUndefined();
  });

  it.each(['crear', 'actualizar', 'eliminar'] as const)(
    '%s exige manage Tecnico y ninguna alternativa',
    (handler) => {
      expect(metadato(CHECK_ABILITY_KEY, handler)).toEqual([
        { action: 'manage', subject: 'Tecnico' },
      ]);
      expect(metadato(CHECK_ANY_ABILITY_KEY, handler)).toBeUndefined();
    },
  );

  it('declara el módulo administracion y los guards en orden', () => {
    expect(Reflect.getMetadata(MODULO_KEY, TecnicosController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, TecnicosController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });
});

describe('TecnicosController — el PoliciesGuard real sobre las rutas reales', () => {
  const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

  const contexto = (
    handler: keyof TecnicosController,
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
      getHandler: () => TecnicosController.prototype[handler],
      getClass: () => TecnicosController,
    } as unknown as ExecutionContext;
  };

  it.each([
    ['pqr.ver'],
    ['pqr.gestionar'],
    ['tecnicos.gestionar'],
    ['mantenimientos.ver'],
    ['mantenimientos.gestionar'],
  ])('listar se permite con %s', (permiso) => {
    expect(guard.canActivate(contexto('listar', [permiso]))).toBe(true);
  });

  it('quien gestiona mantenimientos lista técnicos, pero no los edita', () => {
    // El formulario de mantenimientos necesita el listado; escribir sigue
    // siendo solo de tecnicos.gestionar.
    expect(
      guard.canActivate(contexto('listar', ['mantenimientos.gestionar'])),
    ).toBe(true);
    for (const handler of ['crear', 'actualizar', 'eliminar'] as const) {
      expect(() =>
        guard.canActivate(contexto(handler, ['mantenimientos.gestionar'])),
      ).toThrow(ForbiddenException);
    }
  });

  it('listar se niega a quien no tiene ninguna de las habilidades', () => {
    expect(() =>
      guard.canActivate(contexto('listar', ['tareas.ver', 'zonas.gestionar'])),
    ).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contexto('listar', []))).toThrow(
      ForbiddenException,
    );
  });

  it.each(['crear', 'actualizar', 'eliminar'] as const)(
    '%s solo se permite con tecnicos.gestionar: ni pqr.ver ni pqr.gestionar bastan',
    (handler) => {
      expect(guard.canActivate(contexto(handler, ['tecnicos.gestionar']))).toBe(
        true,
      );
      expect(() => guard.canActivate(contexto(handler, ['pqr.ver']))).toThrow(
        ForbiddenException,
      );
      expect(() =>
        guard.canActivate(contexto(handler, ['pqr.gestionar'])),
      ).toThrow(ForbiddenException);
    },
  );
});

describe('TecnicosController — delegación', () => {
  it('delega cada operación en el servicio', async () => {
    const servicio = {
      listar: jest.fn().mockResolvedValue([]),
      crear: jest.fn().mockResolvedValue({ id: 't1' }),
      actualizar: jest.fn().mockResolvedValue({ id: 't1' }),
      eliminar: jest.fn().mockResolvedValue({ id: 't1' }),
    };
    const controlador = new TecnicosController(servicio as never);

    await controlador.listar();
    await controlador.crear({ nombre: 'Luis' });
    await controlador.actualizar('t1', { especialidad: 'Plomería' });
    await controlador.eliminar('t1');

    expect(servicio.listar).toHaveBeenCalled();
    expect(servicio.crear).toHaveBeenCalledWith({ nombre: 'Luis' });
    expect(servicio.actualizar).toHaveBeenCalledWith('t1', {
      especialidad: 'Plomería',
    });
    expect(servicio.eliminar).toHaveBeenCalledWith('t1');
  });
});
