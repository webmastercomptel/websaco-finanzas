import { Types } from 'mongoose';
import { NotasAnticipoController } from './notas-anticipo.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(notasAnticipo: Record<string, unknown>) {
  return new NotasAnticipoController(notasAnticipo as never);
}

describe('NotasAnticipoController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const notasAnticipo = {
      crear: jest.fn(() => Promise.resolve({ id: 'na-1' })),
    };
    const controller = makeController(notasAnticipo);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      codigo: 'NA',
      reciboOrigenId: new Types.ObjectId().toString(),
      fechaEmision: '2026-09-01',
      aplicacionAutomatica: true,
    });

    expect(notasAnticipo.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('NotasAnticipoController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const notasAnticipo = {
      anular: jest.fn(() => Promise.resolve({ id: 'na-1', estado: 'anulado' })),
    };
    const controller = makeController(notasAnticipo);
    const dto = {
      motivo: 'otro' as const,
      detalle: 'Un detalle de más de veinte caracteres para la anulación',
    };
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.anular(user, 'na-1', dto);

    expect(notasAnticipo.anular).toHaveBeenCalledWith(
      'na-1',
      dto,
      user.accountId,
    );
  });
});

describe('NotasAnticipoController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const notasAnticipo = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(notasAnticipo);

    await controller.findAll({ estado: 'activo' });

    expect(notasAnticipo.findAll).toHaveBeenCalledWith({ estado: 'activo' });
  });

  it('findOne delega el id en el servicio', async () => {
    const notasAnticipo = {
      findOne: jest.fn(() => Promise.resolve({ id: 'na-1' })),
    };
    const controller = makeController(notasAnticipo);

    await controller.findOne('na-1');

    expect(notasAnticipo.findOne).toHaveBeenCalledWith('na-1');
  });
});
