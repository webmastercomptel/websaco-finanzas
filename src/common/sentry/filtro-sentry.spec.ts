import { BadRequestException, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { FiltroExcepcionesSentry, debeReportarse } from './filtro-sentry';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

describe('debeReportarse', () => {
  it('un error inesperado se reporta', () => {
    expect(debeReportarse(new Error('boom'))).toBe(true);
  });

  it('un 5xx explícito se reporta', () => {
    expect(debeReportarse(new HttpException('x', 503))).toBe(true);
  });

  it('un 4xx es la API funcionando, no se reporta', () => {
    expect(debeReportarse(new BadRequestException())).toBe(false);
    expect(debeReportarse(new HttpException('x', 401))).toBe(false);
  });
});

describe('FiltroExcepcionesSentry', () => {
  let delegado: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    delegado = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });
  afterEach(() => delegado.mockRestore());

  it('reporta el error inesperado y deja a Nest responder igual que antes', () => {
    const filtro = new FiltroExcepcionesSentry();
    const error = new Error('boom');
    const host = {} as never;

    filtro.catch(error, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(delegado).toHaveBeenCalledWith(error, host);
  });

  it('no reporta un 4xx pero sí lo deja pasar a Nest', () => {
    const filtro = new FiltroExcepcionesSentry();

    filtro.catch(new BadRequestException(), {} as never);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(delegado).toHaveBeenCalledTimes(1);
  });
});
