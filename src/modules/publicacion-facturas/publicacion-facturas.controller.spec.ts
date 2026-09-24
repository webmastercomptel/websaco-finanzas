import { PublicacionFacturasController } from './publicacion-facturas.controller';
import type { ResumenCiclo } from './publicacion-facturas.contrato';

describe('PublicacionFacturasController', () => {
  it('espera el ciclo completo y devuelve el ResumenCiclo del service tal cual', async () => {
    const resumen: ResumenCiclo = {
      omitido: false,
      reclamadas: 3,
      enviadas: 2,
      reintentar: 1,
      terminales: 0,
    };
    const service = {
      procesarPendientes: jest.fn().mockResolvedValue(resumen),
    };
    const controller = new PublicacionFacturasController(service as never);

    const resultado = await controller.procesarPendientes();

    expect(service.procesarPendientes).toHaveBeenCalledTimes(1);
    expect(resultado).toEqual(resumen);
  });
});
