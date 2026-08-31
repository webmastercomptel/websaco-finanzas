import { Types } from 'mongoose';
import { NotasCreditoController } from './notas-credito.controller';
import type { NotasCreditoService } from './notas-credito.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

describe('NotasCreditoController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const notasCredito = { crear: jest.fn(() => Promise.resolve({ id: 'nc-1' })) };
    const controller = new NotasCreditoController(
      notasCredito as unknown as NotasCreditoService,
    );
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      inmuebleId: new Types.ObjectId().toString(),
      facturaId: new Types.ObjectId().toString(),
      motivo: 'error_facturacion',
      montoTotal: 200000,
      distribucion: [{ conceptoId: new Types.ObjectId().toString(), monto: 200000 }],
    });

    expect(notasCredito.crear).toHaveBeenCalledWith(user.accountId, expect.any(Object));
  });
});

describe('NotasCreditoController.aplicar', () => {
  it('delega en el servicio con el id de ruta y el accountId del caller', async () => {
    const notasCredito = {
      aplicar: jest.fn(() => Promise.resolve({ aplicadas: [], montoSinAplicar: 0, errores: [] })),
    };
    const controller = new NotasCreditoController(notasCredito as unknown as NotasCreditoService);
    const user: IRequestUser = { uid: 'uid-1', email: 'a@b.com', accountId: new Types.ObjectId().toString() };

    await controller.aplicar(user, 'nc-1', { aplicacionAutomatica: true });

    expect(notasCredito.aplicar).toHaveBeenCalledWith('nc-1', { aplicacionAutomatica: true }, user.accountId);
  });
});

describe('NotasCreditoController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const notasCredito = { anular: jest.fn(() => Promise.resolve({ id: 'nc-1', estado: 'anulado' })) };
    const controller = new NotasCreditoController(notasCredito as unknown as NotasCreditoService);
    const dto = { motivo: 'otro' as const, detalle: 'Un detalle de más de veinte caracteres' };
    const user: IRequestUser = { uid: 'uid-1', email: 'a@b.com', accountId: new Types.ObjectId().toString() };

    await controller.anular(user, 'nc-1', dto);

    // Anular es la operación más sensible del módulo: el actor sale del
    // caller autenticado, nunca del body — misma razón que RecibosController.
    expect(notasCredito.anular).toHaveBeenCalledWith('nc-1', dto, user.accountId);
  });
});
