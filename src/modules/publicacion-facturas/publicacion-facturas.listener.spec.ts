import { Logger } from '@nestjs/common';
import { PublicacionFacturasListener } from './publicacion-facturas.listener';
import type { LoteFacturasPdfConfirmadoEvent } from '../../common/eventos/lote-facturas-pdf-confirmado.event';

const EVENTO: LoteFacturasPdfConfirmadoEvent = {
  coPropertyId: '507f1f77bcf86cd799439011',
  loteId: '507f1f77bcf86cd799439012',
  objectPath: 'coproprietats/cop-1/lotes/lote-1.pdf',
  numerosFactura: ['FV-1'],
};

describe('PublicacionFacturasListener', () => {
  it('delega en service.encolar', async () => {
    const service = { encolar: jest.fn().mockResolvedValue(undefined) };
    const listener = new PublicacionFacturasListener(service as never);

    await listener.manejar(EVENTO);

    expect(service.encolar).toHaveBeenCalledWith(EVENTO);
  });

  it('un error de service.encolar nunca se propaga — solo se loguea', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const service = {
      encolar: jest.fn().mockRejectedValue(new Error('mongo down')),
    };
    const listener = new PublicacionFacturasListener(service as never);

    await expect(listener.manejar(EVENTO)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
