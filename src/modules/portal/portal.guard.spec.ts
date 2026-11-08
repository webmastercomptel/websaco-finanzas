import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PortalController } from './portal.controller';
import { PortalGuard } from './portal.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const guardCon = (modulo?: string) =>
  new PortalGuard({
    getAllAndOverride: () => modulo,
  } as unknown as Reflector);

const contexto = (user?: IRequestUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

const residente = (over: Partial<IRequestUser> = {}): IRequestUser => ({
  uid: 'uid-1',
  email: 'ana@ejemplo.com',
  accountId: 'acc-1',
  copropiedadId: 'cop-1',
  esResidente: true,
  modulos: ['finanzas'],
  permissions: [],
  ...over,
});

describe('PortalGuard', () => {
  it('deja pasar a un residente de una copropiedad con el módulo contratado', () => {
    expect(guardCon('finanzas').canActivate(contexto(residente()))).toBe(true);
  });

  it('deniega a quien no es residente de la copropiedad activa', () => {
    expect(() =>
      guardCon('finanzas').canActivate(
        contexto(residente({ esResidente: false })),
      ),
    ).toThrow(ForbiddenException);
  });

  it('deniega sin copropiedad activa o sin cuenta local', () => {
    expect(() =>
      guardCon('finanzas').canActivate(
        contexto(residente({ copropiedadId: undefined })),
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      guardCon('finanzas').canActivate(
        contexto(residente({ accountId: undefined })),
      ),
    ).toThrow(ForbiddenException);
  });

  it('deniega sin usuario autenticado', () => {
    expect(() => guardCon('finanzas').canActivate(contexto())).toThrow(
      ForbiddenException,
    );
  });

  it('deniega si la copropiedad no contrató el módulo de la ruta', () => {
    expect(() =>
      guardCon('administracion').canActivate(contexto(residente())),
    ).toThrow(ForbiddenException);
  });
});

/**
 * Contra las rutas REALES del controlador (metadata incluida), no contra un
 * stub: lo que importa es qué ve cada tipo de edificio, y eso lo deciden los
 * decoradores de verdad.
 */
describe('PortalGuard — rutas reales de /portal según los módulos contratados', () => {
  const guard = new PortalGuard(new Reflector());

  type Ruta = 'unidades' | 'facturas' | 'documentoPdf' | 'estadoCuenta';

  /** The real handler function, looked up by name so its metadata is read. */
  const handlerDe = (ruta: Ruta): object =>
    (PortalController.prototype as unknown as Record<Ruta, object>)[ruta];

  const ctx = (ruta: Ruta, user: IRequestUser): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => handlerDe(ruta),
      getClass: () => PortalController,
    }) as unknown as ExecutionContext;

  const rutasFinanzas: Ruta[] = ['facturas', 'documentoPdf', 'estadoCuenta'];

  it('edificio solo-Administración: el residente lista sus unidades (200)', () => {
    expect(
      guard.canActivate(
        ctx('unidades', residente({ modulos: ['administracion'] })),
      ),
    ).toBe(true);
  });

  it.each(rutasFinanzas)(
    'edificio solo-Administración: %s sigue siendo solo de Finanzas (403)',
    (ruta) => {
      expect(() =>
        guard.canActivate(
          ctx(ruta, residente({ modulos: ['administracion'] })),
        ),
      ).toThrow(ForbiddenException);
    },
  );

  it('edificio solo-Finanzas: nada cambia, unidades y rutas financieras pasan', () => {
    const user = residente({ modulos: ['finanzas'] });
    expect(guard.canActivate(ctx('unidades', user))).toBe(true);
    for (const ruta of rutasFinanzas) {
      expect(guard.canActivate(ctx(ruta, user))).toBe(true);
    }
  });

  it('edificio con ambos módulos: todo pasa', () => {
    const user = residente({ modulos: ['finanzas', 'administracion'] });
    expect(guard.canActivate(ctx('unidades', user))).toBe(true);
    expect(guard.canActivate(ctx('facturas', user))).toBe(true);
  });

  it('edificio sin ningún módulo: 403 en todas las rutas', () => {
    const user = residente({ modulos: [] });
    for (const ruta of ['unidades', ...rutasFinanzas] as Ruta[]) {
      expect(() => guard.canActivate(ctx(ruta, user))).toThrow(
        ForbiddenException,
      );
    }
  });

  it('quien no es residente de la copropiedad activa recibe 403 aunque haya módulo', () => {
    expect(() =>
      guard.canActivate(
        ctx(
          'unidades',
          residente({ esResidente: false, modulos: ['administracion'] }),
        ),
      ),
    ).toThrow(ForbiddenException);
  });
});
