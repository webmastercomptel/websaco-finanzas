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
import { EquiposController } from './equipos.controller';

const metadato = (key: string, handler: keyof EquiposController) =>
  Reflect.getMetadata(
    key,
    // Only the function object is read for its metadata; it is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    EquiposController.prototype[handler],
  ) as RequiredRule[] | undefined;

describe('EquiposController — política de acceso', () => {
  it('cuelga de equipos', () => {
    expect(Reflect.getMetadata(PATH_METADATA, EquiposController)).toBe(
      'equipos',
    );
  });

  it('el listado exige read Mantenimiento y nada más', () => {
    expect(metadato(CHECK_ABILITY_KEY, 'listar')).toEqual([
      { action: 'read', subject: 'Mantenimiento' },
    ]);
    expect(metadato(CHECK_ANY_ABILITY_KEY, 'listar')).toBeUndefined();
  });

  it.each(['crear', 'actualizar', 'eliminar'] as const)(
    '%s exige manage Mantenimiento y ninguna alternativa',
    (handler) => {
      expect(metadato(CHECK_ABILITY_KEY, handler)).toEqual([
        { action: 'manage', subject: 'Mantenimiento' },
      ]);
      expect(metadato(CHECK_ANY_ABILITY_KEY, handler)).toBeUndefined();
    },
  );

  it('declara el módulo administracion y los guards en orden', () => {
    expect(Reflect.getMetadata(MODULO_KEY, EquiposController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, EquiposController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });
});

describe('EquiposController — el PoliciesGuard real sobre las rutas reales', () => {
  const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

  const contexto = (
    handler: keyof EquiposController,
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
      getHandler: () => EquiposController.prototype[handler],
      getClass: () => EquiposController,
    } as unknown as ExecutionContext;
  };

  it.each([['mantenimientos.ver'], ['mantenimientos.gestionar']])(
    'listar se permite con %s',
    (permiso) => {
      expect(guard.canActivate(contexto('listar', [permiso]))).toBe(true);
    },
  );

  it('quien solo ve mantenimientos lista equipos pero no los escribe', () => {
    for (const handler of ['crear', 'actualizar', 'eliminar'] as const) {
      expect(() =>
        guard.canActivate(contexto(handler, ['mantenimientos.ver'])),
      ).toThrow(ForbiddenException);
      expect(
        guard.canActivate(contexto(handler, ['mantenimientos.gestionar'])),
      ).toBe(true);
    }
  });

  it('sin permisos de mantenimiento todo se niega', () => {
    expect(() =>
      guard.canActivate(contexto('listar', ['pqr.ver', 'tecnicos.gestionar'])),
    ).toThrow(ForbiddenException);
  });
});

describe('EquiposController — delegación', () => {
  it('delega cada operación en el servicio', async () => {
    const servicio = {
      listar: jest.fn().mockResolvedValue([]),
      crear: jest.fn().mockResolvedValue({ id: 'e1' }),
      actualizar: jest.fn().mockResolvedValue({ id: 'e1' }),
      eliminar: jest.fn().mockResolvedValue({ id: 'e1' }),
    };
    const controlador = new EquiposController(servicio as never);

    await controlador.listar({ estado: 'operativo' });
    await controlador.crear({ nombre: 'Bomba' });
    await controlador.actualizar('e1', { marca: 'X' });
    await controlador.eliminar('e1');

    expect(servicio.listar).toHaveBeenCalledWith({ estado: 'operativo' });
    expect(servicio.crear).toHaveBeenCalledWith({ nombre: 'Bomba' });
    expect(servicio.actualizar).toHaveBeenCalledWith('e1', { marca: 'X' });
    expect(servicio.eliminar).toHaveBeenCalledWith('e1');
  });
});

describe('EquiposController — hoja de vida', () => {
  it('exige read Mantenimiento', () => {
    expect(metadato(CHECK_ABILITY_KEY, 'hojaDeVida')).toEqual([
      { action: 'read', subject: 'Mantenimiento' },
    ]);
  });

  it('declara :id/hoja-de-vida y delega en el servicio', async () => {
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        // eslint-disable-next-line @typescript-eslint/unbound-method
        EquiposController.prototype.hojaDeVida,
      ),
    ).toBe(':id/hoja-de-vida');
    const servicio = { hojaDeVida: jest.fn().mockResolvedValue({}) };
    await new EquiposController(servicio as never).hojaDeVida('e1');
    expect(servicio.hojaDeVida).toHaveBeenCalledWith('e1');
  });
});
