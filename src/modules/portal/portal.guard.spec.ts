import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
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
