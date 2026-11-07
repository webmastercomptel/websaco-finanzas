import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
} from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { ZonasPortalController } from './zonas-portal.controller';

const handlers = (): Array<[string, object]> =>
  Object.getOwnPropertyNames(ZonasPortalController.prototype)
    .filter((n) => n !== 'constructor')
    .map((n): [string, object] => [
      n,
      (ZonasPortalController.prototype as unknown as Record<string, object>)[n],
    ])
    .filter(([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined);

describe('ZonasPortalController — metadatos de acceso', () => {
  it('cuelga de portal/espacios', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ZonasPortalController)).toBe(
      'portal/espacios',
    );
  });

  it('usa PortalGuard después de FirebaseAuthGuard (PortalGuard lee request.user)', () => {
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, ZonasPortalController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);

    expect(guards).toEqual(['FirebaseAuthGuard', 'PortalGuard']);
  });

  it('declara el módulo administracion', () => {
    expect(Reflect.getMetadata(MODULO_KEY, ZonasPortalController)).toBe(
      'administracion',
    );
  });

  it('ninguna ruta del residente pasa por CASL: los residentes no tienen permisos', () => {
    for (const [, fn] of handlers()) {
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, fn)).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(CHECK_ABILITY_KEY, ZonasPortalController),
    ).toBeUndefined();
  });

  it('el residente solo puede listar: ninguna ruta de escritura', () => {
    expect(
      handlers().map(([nombre, fn]) => [
        nombre,
        Reflect.getMetadata(METHOD_METADATA, fn) as number,
      ]),
    ).toEqual([['listar', 0]]); // 0 = RequestMethod.GET
  });
});

describe('ZonasPortalController — el PortalGuard real', () => {
  const guard = new PortalGuard(new Reflector());

  const contexto = (user: Partial<IRequestUser>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      // Only the function object is read for its metadata; it is never called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => ZonasPortalController.prototype.listar,
      getClass: () => ZonasPortalController,
    }) as unknown as ExecutionContext;

  const base: IRequestUser = {
    uid: 'u',
    email: 'r@x.co',
    accountId: 'cuenta-1',
    copropiedadId: 'cop-1',
    esResidente: true,
    modulos: ['administracion'],
  };

  it('deja pasar a quien tiene una unidad en la copropiedad activa con el módulo contratado', () => {
    expect(guard.canActivate(contexto(base))).toBe(true);
  });

  it('niega a quien no es residente de la copropiedad activa', () => {
    expect(() =>
      guard.canActivate(contexto({ ...base, esResidente: false })),
    ).toThrow(ForbiddenException);
  });

  it('niega si la copropiedad no contrató el módulo administracion', () => {
    expect(() =>
      guard.canActivate(contexto({ ...base, modulos: ['finanzas'] })),
    ).toThrow(ForbiddenException);
  });
});

describe('ZonasPortalController — delegación', () => {
  it('listar entrega los filtros al servicio', async () => {
    const zonas = { listarEspacios: jest.fn().mockResolvedValue([]) };
    const controlador = new ZonasPortalController(zonas as never);

    await controlador.listar({ categoria: 'deportes' });

    expect(zonas.listarEspacios).toHaveBeenCalledWith({
      categoria: 'deportes',
    });
  });
});
