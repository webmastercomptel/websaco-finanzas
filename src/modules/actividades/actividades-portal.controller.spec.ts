import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
} from '../casl/check-ability.decorator';
import { ActividadesPortalController } from './actividades-portal.controller';

const handlers = (): Array<[string, object]> =>
  Object.getOwnPropertyNames(ActividadesPortalController.prototype)
    .filter((n) => n !== 'constructor')
    .map((n): [string, object] => [
      n,
      (
        ActividadesPortalController.prototype as unknown as Record<
          string,
          object
        >
      )[n],
    ])
    .filter(([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined);

describe('ActividadesPortalController — metadatos de acceso', () => {
  it('cuelga de portal/actividades', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, ActividadesPortalController),
    ).toBe('portal/actividades');
  });

  it('usa PortalGuard después de FirebaseAuthGuard (PortalGuard lee request.user)', () => {
    const guards = (
      Reflect.getMetadata(
        GUARDS_METADATA,
        ActividadesPortalController,
      ) as Array<{ name: string }>
    ).map((g) => g.name);

    expect(guards).toEqual(['FirebaseAuthGuard', 'PortalGuard']);
  });

  it('declara el módulo administracion', () => {
    expect(Reflect.getMetadata(MODULO_KEY, ActividadesPortalController)).toBe(
      'administracion',
    );
  });

  it('ninguna ruta del residente pasa por CASL: los residentes no tienen permisos', () => {
    for (const [, fn] of handlers()) {
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, fn)).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(CHECK_ABILITY_KEY, ActividadesPortalController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, ActividadesPortalController),
    ).toBeUndefined();
  });

  it('expone exactamente listar, asistir (POST) y dejar de asistir (DELETE): sin alternar', () => {
    expect(
      handlers()
        .map(([nombre, fn]) => [
          nombre,
          RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number],
          String(Reflect.getMetadata(PATH_METADATA, fn)),
        ])
        .sort(),
    ).toEqual([
      ['asistir', 'POST', ':id/asistir'],
      ['dejarDeAsistir', 'DELETE', ':id/asistir'],
      ['listar', 'GET', '/'],
    ]);
  });
});

describe('ActividadesPortalController — delegación', () => {
  const user: IRequestUser = {
    uid: 'u',
    email: 'a@b.co',
    accountId: 'cuenta-1',
    nombre: 'Ana',
  };

  it('pasa filtros y usuario autenticado al listar, y el id y el usuario al asistir', async () => {
    const servicio = {
      listarParaResidente: jest.fn().mockResolvedValue([]),
      asistir: jest.fn().mockResolvedValue({ asistiendo: true, asistentes: 1 }),
      dejarDeAsistir: jest
        .fn()
        .mockResolvedValue({ asistiendo: false, asistentes: 0 }),
    };
    const controlador = new ActividadesPortalController(servicio as never);

    await controlador.listar({ categoria: 'salud' }, user);
    const resultado = await controlador.asistir('a1', user);

    expect(servicio.listarParaResidente).toHaveBeenCalledWith(
      { categoria: 'salud' },
      user,
    );
    expect(servicio.asistir).toHaveBeenCalledWith('a1', user);
    expect(resultado).toEqual({ asistiendo: true, asistentes: 1 });

    await controlador.dejarDeAsistir('a1', user);
    expect(servicio.dejarDeAsistir).toHaveBeenCalledWith('a1', user);
  });
});
