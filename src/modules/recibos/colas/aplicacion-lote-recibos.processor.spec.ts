import { Types } from 'mongoose';
import { AplicacionLoteRecibosProcessor } from './aplicacion-lote-recibos.processor';

describe('AplicacionLoteRecibosProcessor', () => {
  it('delega en LoteRecibosService.ejecutarAplicacion con los datos del job', async () => {
    const resultado = { lote: {} as never, errores: [] };
    const loteRecibos = {
      ejecutarAplicacion: jest.fn().mockResolvedValue(resultado),
    };
    const processor = new AplicacionLoteRecibosProcessor(loteRecibos as never);

    const coPropertyId = new Types.ObjectId().toString();
    const job = {
      data: { loteId: 'lote-1', coPropertyId, accountId: 'cuenta-1' },
    };

    const salida = await processor.process(job as never);

    expect(loteRecibos.ejecutarAplicacion).toHaveBeenCalledWith(
      'lote-1',
      new Types.ObjectId(coPropertyId),
      'cuenta-1',
      job,
    );
    expect(salida).toBe(resultado);
  });
});
