import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
} from '../casl/check-ability.decorator';
import { AnunciosPortalController } from './anuncios-portal.controller';

const handlers = (): Array<[string, object]> =>
  Object.getOwnPropertyNames(AnunciosPortalController.prototype)
    .filter((n) => n !== 'constructor')
    .map((n): [string, object] => [
      n,
      (AnunciosPortalController.prototype as unknown as Record<string, object>)[
        n
      ],
    ])
    .filter(([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined);

describe('AnunciosPortalController — metadatos de acceso', () => {
  it('cuelga de portal/anuncios', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AnunciosPortalController)).toBe(
      'portal/anuncios',
    );
  });

  it('usa PortalGuard después de FirebaseAuthGuard (PortalGuard lee request.user)', () => {
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, AnunciosPortalController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);

    expect(guards).toEqual(['FirebaseAuthGuard', 'PortalGuard']);
  });

  it('declara el módulo administracion', () => {
    expect(Reflect.getMetadata(MODULO_KEY, AnunciosPortalController)).toBe(
      'administracion',
    );
  });

  it('ninguna ruta del residente pasa por CASL: los residentes no tienen permisos', () => {
    for (const [, fn] of handlers()) {
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, fn)).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(CHECK_ABILITY_KEY, AnunciosPortalController),
    ).toBeUndefined();
  });

  it('el residente no puede escribir: solo listar, vista y like (sin POST de creación, PATCH, DELETE ni publicar)', () => {
    expect(
      handlers()
        .map(([nombre, fn]) => [
          nombre,
          String(Reflect.getMetadata(PATH_METADATA, fn)),
        ])
        .sort(),
    ).toEqual([
      ['like', ':id/like'],
      ['listar', '/'],
      ['vista', ':id/vista'],
    ]);
  });

  it('ninguna ruta recibe cuerpo: el residente no manda datos a guardar', () => {
    for (const [nombre] of handlers()) {
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        AnunciosPortalController,
        nombre,
      ) as Record<string, { data?: unknown }> | undefined;
      // RouteParamtypes.BODY === 3
      const hayBody = Object.keys(args ?? {}).some((k) => k.startsWith('3:'));
      expect(hayBody).toBe(false);
    }
  });
});

describe('AnunciosPortalController — delegación', () => {
  const user: IRequestUser = {
    uid: 'u',
    email: 'a@b.co',
    accountId: 'cuenta-1',
    nombre: 'Ana',
  };

  it('pasa filtros y usuario autenticado al listar, y el id y el usuario a vista y like', async () => {
    const servicio = {
      listarParaResidente: jest.fn().mockResolvedValue([]),
      registrarVista: jest.fn().mockResolvedValue({ id: 'a1' }),
      alternarMeGusta: jest.fn().mockResolvedValue({ id: 'a1' }),
    };
    const controlador = new AnunciosPortalController(servicio as never);

    await controlador.listar({ categoria: 'seguridad' }, user);
    await controlador.vista('a1', user);
    await controlador.like('a1', user);

    expect(servicio.listarParaResidente).toHaveBeenCalledWith(
      { categoria: 'seguridad' },
      user,
    );
    expect(servicio.registrarVista).toHaveBeenCalledWith('a1', user);
    expect(servicio.alternarMeGusta).toHaveBeenCalledWith('a1', user);
  });
});
