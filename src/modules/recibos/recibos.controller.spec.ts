import { Types } from 'mongoose';
import { RecibosController } from './recibos.controller';
import type { RecibosService } from './recibos.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

describe('RecibosController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const recibos = { crear: jest.fn(() => Promise.resolve({ id: 'rec-1' })) };
    const controller = new RecibosController(
      recibos as unknown as RecibosService,
    );
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      inmuebleId: new Types.ObjectId().toString(),
      terceroId: new Types.ObjectId().toString(),
      montoRecibido: 100000,
      fechaRecibo: '2026-08-27',
      medioPago: 'efectivo',
      cuentaDestino: 'caja-1',
    });

    expect(recibos.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('RecibosController.aplicar', () => {
  it('delega en el servicio con el id de ruta y el accountId del caller', async () => {
    const recibos = {
      aplicar: jest.fn(() =>
        Promise.resolve({ aplicadas: [], montoSinAplicar: 0, errores: [] }),
      ),
    };
    const controller = new RecibosController(recibos as unknown as RecibosService);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.aplicar(user, 'rec-1', { aplicacionAutomatica: true });

    expect(recibos.aplicar).toHaveBeenCalledWith(
      'rec-1',
      { aplicacionAutomatica: true },
      user.accountId,
    );
  });
});
