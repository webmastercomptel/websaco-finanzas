import { Types } from 'mongoose';
import { RecibosController } from './recibos.controller';
import type { RecibosService } from './recibos.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(recibos: Record<string, unknown>) {
  return new RecibosController(
    recibos as never,
    {} as TenantContextService,
    { findById: jest.fn() } as never,
  );
}

describe('RecibosController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const recibos = { crear: jest.fn(() => Promise.resolve({ id: 'rec-1' })) };
    const controller = makeController(recibos);
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
    const controller = makeController(recibos);
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

describe('RecibosController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const recibos = {
      anular: jest.fn(() =>
        Promise.resolve({ id: 'rec-1', estado: 'anulado' }),
      ),
    };
    const controller = makeController(recibos);
    const dto = {
      motivo: 'otro' as const,
      detalle: 'Un detalle de más de veinte caracteres',
    };
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.anular(user, 'rec-1', dto);

    // Anular es la operación más sensible del módulo (motivo obligatorio +
    // justificación de 20 caracteres, y cascada sobre cada aplicación): el
    // actor sale del caller autenticado, nunca del body.
    expect(recibos.anular).toHaveBeenCalledWith('rec-1', dto, user.accountId);
  });
});

describe('RecibosController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const recibos = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(recibos);

    await controller.findAll({ estado: 'activo' });

    expect(recibos.findAll).toHaveBeenCalledWith({ estado: 'activo' });
  });

  it('findOne delega el id en el servicio', async () => {
    const recibos = {
      findOne: jest.fn(() => Promise.resolve({ id: 'rec-1' })),
    };
    const controller = makeController(recibos);

    await controller.findOne('rec-1');

    expect(recibos.findOne).toHaveBeenCalledWith('rec-1');
  });
});
