import { Logger } from '@nestjs/common';
import { PublicacionFacturasListener } from './publicacion-facturas.listener';
import type { LoteFacturasPdfConfirmadoEvent } from '../../common/eventos/lote-facturas-pdf-confirmado.event';

const EVENTO: LoteFacturasPdfConfirmadoEvent = {
  copropiedadId: '507f1f77bcf86cd799439011',
  loteId: '507f1f77bcf86cd799439012',
  objectPath: 'coproprietats/cop-1/lotes/lote-1.pdf',
  numerosFactura: ['FV-1'],
};

describe('PublicacionFacturasListener', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('delega en service.encolar', async () => {
    const service = {
      encolar: jest.fn().mockResolvedValue(false),
      publicarAhora: jest.fn().mockResolvedValue(undefined),
    };
    const listener = new PublicacionFacturasListener(service as never);

    await listener.manejar(EVENTO);

    expect(service.encolar).toHaveBeenCalledWith(EVENTO);
  });

  it('cuando encolar devuelve true, despacha el lote con publicarAhora(loteId), después de encolar', async () => {
    const orden: string[] = [];
    const service = {
      encolar: jest.fn(() => {
        orden.push('encolar');
        return Promise.resolve(true);
      }),
      publicarAhora: jest.fn(() => {
        orden.push('publicarAhora');
        return Promise.resolve();
      }),
    };
    const listener = new PublicacionFacturasListener(service as never);

    await listener.manejar(EVENTO);

    expect(service.publicarAhora).toHaveBeenCalledWith(EVENTO.loteId);
    expect(orden).toEqual(['encolar', 'publicarAhora']);
  });

  it('cuando encolar devuelve false, NO despacha nada', async () => {
    const service = {
      encolar: jest.fn().mockResolvedValue(false),
      publicarAhora: jest.fn().mockResolvedValue(undefined),
    };
    const listener = new PublicacionFacturasListener(service as never);

    await listener.manejar(EVENTO);

    expect(service.publicarAhora).not.toHaveBeenCalled();
  });

  it('espera (await) a que publicarAhora termine antes de resolver: el envío cabe en el request', async () => {
    let terminoElEnvio = false;
    const service = {
      encolar: jest.fn().mockResolvedValue(true),
      publicarAhora: jest.fn(
        () =>
          new Promise<void>((resolve) =>
            setImmediate(() => {
              terminoElEnvio = true;
              resolve();
            }),
          ),
      ),
    };
    const listener = new PublicacionFacturasListener(service as never);

    await listener.manejar(EVENTO);

    expect(terminoElEnvio).toBe(true);
  });

  it('un error de service.encolar nunca se propaga — solo se loguea — y no despacha', async () => {
    const service = {
      encolar: jest.fn().mockRejectedValue(new Error('mongo down')),
      publicarAhora: jest.fn().mockResolvedValue(undefined),
    };
    const listener = new PublicacionFacturasListener(service as never);

    await expect(listener.manejar(EVENTO)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(service.publicarAhora).not.toHaveBeenCalled();
  });

  it('un error de service.publicarAhora nunca se propaga — solo se loguea', async () => {
    const service = {
      encolar: jest.fn().mockResolvedValue(true),
      publicarAhora: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const listener = new PublicacionFacturasListener(service as never);

    await expect(listener.manejar(EVENTO)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('un throw síncrono de publicarAhora tampoco se propaga', async () => {
    const service = {
      encolar: jest.fn().mockResolvedValue(true),
      publicarAhora: jest.fn(() => {
        throw new Error('sync boom');
      }),
    };
    const listener = new PublicacionFacturasListener(service as never);

    await expect(listener.manejar(EVENTO)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
