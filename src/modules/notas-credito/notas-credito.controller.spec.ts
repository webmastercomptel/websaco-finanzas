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
