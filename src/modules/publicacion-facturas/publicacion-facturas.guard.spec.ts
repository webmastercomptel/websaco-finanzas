import { Logger, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { SecretoProgramadorGuard } from './publicacion-facturas.guard';

const SECRET = 'un-secreto-de-cloud-scheduler-de-al-menos-32-chars';

const mockConfig = (secreto: string | undefined) => ({
  get: jest.fn(() => secreto),
});

const mockContext = (headerValue?: string | string[]): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers:
          headerValue === undefined
            ? {}
            : { 'x-scheduler-secret': headerValue },
      }),
    }),
  }) as unknown as ExecutionContext;

describe('SecretoProgramadorGuard', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('sin secreto configurado, rechaza (falla cerrado) aunque el header sea correcto', () => {
    const guard = new SecretoProgramadorGuard(mockConfig(undefined) as never);

    expect(() => guard.canActivate(mockContext(SECRET))).toThrow(
      UnauthorizedException,
    );
  });

  it('sin el header, rechaza', () => {
    const guard = new SecretoProgramadorGuard(mockConfig(SECRET) as never);

    expect(() => guard.canActivate(mockContext(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('con un header incorrecto, rechaza', () => {
    const guard = new SecretoProgramadorGuard(mockConfig(SECRET) as never);

    expect(() => guard.canActivate(mockContext('valor-incorrecto'))).toThrow(
      UnauthorizedException,
    );
  });

  it('con el header correcto, deja pasar', () => {
    const guard = new SecretoProgramadorGuard(mockConfig(SECRET) as never);

    expect(guard.canActivate(mockContext(SECRET))).toBe(true);
  });

  it('el valor del header nunca se loguea', () => {
    const guard = new SecretoProgramadorGuard(mockConfig(SECRET) as never);

    expect(() =>
      guard.canActivate(mockContext('valor-incorrecto-y-secreto')),
    ).toThrow(UnauthorizedException);

    const mensajes = warnSpy.mock.calls.flat().map(String);
    for (const mensaje of mensajes) {
      expect(mensaje).not.toContain('valor-incorrecto-y-secreto');
      expect(mensaje).not.toContain(SECRET);
    }
  });
});
